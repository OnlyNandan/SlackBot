require('dotenv').config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const { Client } = require("@notionhq/client");
const NodeCache = require("node-cache");

let indexedKnowledge = "No knowledge has been indexed yet. Please run the /index command.";
const conversationCache = new NodeCache({ stdTTL: 600 });

async function getGoogleDocContent(documentId) {
    if (!documentId) return "Error: Google Doc ID is not configured.";
    try {
        let auth;
        if (process.env.GOOGLE_CREDENTIALS_JSON) {
            const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
            auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/documents.readonly'] });
        } else {
            auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/documents.readonly'] });
        }
        const authClient = await auth.getClient();
        const docs = google.docs({ version: 'v1', auth: authClient });
        const res = await docs.documents.get({ documentId });
        let text = '';
        res.data.body.content.forEach(element => {
            if (element.paragraph) {
                element.paragraph.elements.forEach(elem => {
                    if (elem.textRun) { text += elem.textRun.content; }
                });
            }
        });
        return text;
    } catch (error) {
        console.error("❌ Error fetching from Google Docs:", error.message);
        return "Error: Could not retrieve the Google Docs document.";
    }
}

async function getNotionPageContent(pageId) {
    if (!pageId) return "Error: Notion Page ID is not configured.";
    if (!process.env.NOTION_API_KEY) return "Error: Notion API Key is not configured.";
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    try {
        const response = await notion.blocks.children.list({ block_id: pageId });
        let text = '';
        for (const block of response.results) {
            if (block.type && block[block.type].rich_text) {
                text += block[block.type].rich_text.map(rt => rt.plain_text).join('');
                text += '\n';
            }
        }
        return text;
    } catch (error) {
        console.error("❌ Error fetching from Notion:", error.message);
        return "Error: Could not retrieve the Notion document.";
    }
}

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
receiver.router.get('/', (req, res) => { res.status(200).send('I am alive and ready to serve!'); });

const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver: receiver });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.command('/index', async ({ command, ack, say }) => {
    await ack();
    say(`Got it, ${command.user_name}! Starting the indexing process. This might take a moment...`);
    
    const googleDocId = process.env.GOOGLE_DOC_ID;
    const notionPageId = process.env.NOTION_PAGE_ID;

    console.log("INDEXING: Fetching content from Google Docs and Notion...");
    const [googleContent, notionContent] = await Promise.all([
        getGoogleDocContent(googleDocId),
        getNotionPageContent(notionPageId)
    ]);

    indexedKnowledge = `
        --- GOOGLE DOCS ---
        ${googleContent}
        --- NOTION ---
        ${notionContent}
    `;

    console.log("✅ INDEXING COMPLETE!");
    say("All knowledge sources have been successfully indexed and are ready for questions.");
});

app.event('app_mention', async ({ event, client, say }) => {
    const userQuestion = event.text.replace(/<@.*?>/g, '').trim();
    const conversationId = `convo-${event.user}-${event.channel}`;
    const previousConversation = conversationCache.get(conversationId);

    try {
        const contextDocument = indexedKnowledge;
        
        // --- Generate the main answer ---
        let answerPrompt = `
          You are a helpful assistant. First, consider the PREVIOUS CONTEXT if it exists. Then, answer the new QUESTION based *only* on the provided DOCUMENT.
          If the answer is not found in the document, say "I do not have information on that."
          PREVIOUS CONTEXT: ${previousConversation ? `User asked: "${previousConversation.question}" and you answered: "${previousConversation.answer}"` : "None"}
          DOCUMENT: --- ${contextDocument} ---
          NEW QUESTION: "${userQuestion}"
        `;
        const answerResult = await model.generateContent(answerPrompt);
        const mainAnswer = answerResult.response.text();

        // --- Generate predictive follow-up questions ---
        let suggestionPrompt = `
            Based on the following question and answer, suggest three likely follow-up questions.
            Return ONLY a JavaScript-style array of strings, like ["question 1", "question 2", "question 3"]. Do not include any other text or formatting.
            Question: "${userQuestion}"
            Answer: "${mainAnswer}"
        `;
        const suggestionResult = await model.generateContent(suggestionPrompt);
        const suggestionText = suggestionResult.response.text();
        
        let suggestions = [];
        try {
            // We use a regex to find the array-like string in the AI's response
            const arrayStringMatch = suggestionText.match(/\[(.*?)\]/);
            if (arrayStringMatch) {
                // Safely parse the string into a real array
                suggestions = JSON.parse(arrayStringMatch[0]);
            }
        } catch (e) {
            console.error("Could not parse suggestions from AI:", suggestionText);
        }

        // --- Update conversation history ---
        conversationCache.set(conversationId, { question: userQuestion, answer: mainAnswer });

        // --- Send the response to Slack with interactive buttons ---
        await say({
            text: mainAnswer, // Main answer text
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: mainAnswer
                    }
                },
                // Only show the suggestions section if we have suggestions
                ...(suggestions.length > 0 ? [
                    {
                        type: "divider"
                    },
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: "You might also want to ask:"
                        }
                    },
                    {
                        type: "actions",
                        elements: suggestions.slice(0, 3).map(q => ({ // Max 3 buttons
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: q,
                                emoji: true
                            },
                            value: q // The question text itself
                        }))
                    }
                ] : [])
            ]
        });

    } catch (error) {
        console.error("❌ Error processing AI request:", error);
        await say("Sorry, I encountered an error while thinking. Please try again.");
    }
});

// NEW: Add a listener for when a user clicks a suggestion button
app.action(/.*/, async ({ action, ack, say, body }) => {
    // Acknowledge the button click
    await ack();
    // The 'value' of the button is the question text we want to ask
    const question = action.value;
    // Post a message as the user, which will trigger the @mention handler again
    await say(`<@${body.user.id}> ${question}`);
});


(async () => {
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Bolt app is running on port ${port}!`);
})();