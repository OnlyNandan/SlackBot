require('dotenv').config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const { Client } = require("@notionhq/client");
const NodeCache = require("node-cache");

let indexedKnowledge = "No knowledge has been indexed yet. Please run the /index command.";
const conversationCache = new NodeCache({ stdTTL: 600 });

async function getGoogleDocContent(documentId) {
    if (!documentId) { console.error("❌ Google Doc ID is missing."); return "Error: Google Doc ID is not configured."; }
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
            if (element.paragraph) { element.paragraph.elements.forEach(elem => { if (elem.textRun) { text += elem.textRun.content; } }); }
        });
        return text;
    } catch (error) {
        console.error("❌ Error fetching from Google Docs:", error.message);
        return "Error: Could not retrieve the Google Docs document.";
    }
}

async function getNotionPageContent(pageId) {
    if (!pageId) { console.error("❌ Notion Page ID is missing."); return "Error: Notion Page ID is not configured."; }
    if (!process.env.NOTION_API_KEY) { console.error("❌ Notion API Key is missing."); return "Error: Notion API Key is not configured."; }
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    try {
        const response = await notion.blocks.children.list({ block_id: pageId });
        let text = '';
        for (const block of response.results) {
            if (block.type && block[block.type].rich_text) {
                text += block[block.type].rich_text.map(rt => rt.plain_text).join('') + '\n';
            }
        }
        return text;
    } catch (error) {
        console.error("❌ Error fetching from Notion:", error.message);
        return "Error: Could not retrieve the Notion document.";
    }
}

async function processQuestion(userQuestion, conversationId) {
    const previousConversation = conversationCache.get(conversationId);
    const contextDocument = indexedKnowledge;
    
    const answerPrompt = `
      You are an expert assistant. Your task is to answer the user's NEW QUESTION.
      Follow these rules strictly:
      1.  First, look at the PREVIOUS CONTEXT to understand what the user is asking about, especially if the new question is a follow-up (e.g., uses "it", "they", "why?").
      2.  Then, find the answer to the fully understood question within the provided DOCUMENT.
      3.  Answer concisely and directly. Do NOT mention that you are answering "based on the document" or any similar phrases.
      4.  If the answer cannot be found in the DOCUMENT, you must respond with "I do not have information on that."

      PREVIOUS CONTEXT:
      ${previousConversation ? `The user asked: "${previousConversation.question}". You answered: "${previousConversation.answer}"` : "None."}
      ---
      DOCUMENT:
      ${contextDocument}
      ---
      NEW QUESTION:
      "${userQuestion}"
    `;

    const answerResult = await model.generateContent(answerPrompt);
    const mainAnswer = answerResult.response.text();

    // --- THIS IS THE UPDATED PROMPT FOR SUGGESTIONS ---
    const suggestionPrompt = `
        You are a suggestion generator. Your task is to suggest three distinct follow-up questions.
        
        Follow these rules strictly:
        1.  The suggested questions MUST be answerable using ONLY the information found in the provided DOCUMENT.
        2.  Do not suggest questions if the answer is already obvious from the original ANSWER.
        3.  Return ONLY a JavaScript-style array of strings, like ["question 1", "question 2", "question 3"].

        DOCUMENT:
        ---
        ${contextDocument}
        ---
        ORIGINAL QUESTION: "${userQuestion}"
        ORIGINAL ANSWER: "${mainAnswer}"
    `;
    const suggestionResult = await model.generateContent(suggestionPrompt);
    const suggestionText = suggestionResult.response.text();
    
    let suggestions = [];
    try {
        const arrayStringMatch = suggestionText.match(/\[(.*?)\]/s);
        if (arrayStringMatch) {
            const parsedSuggestions = JSON.parse(arrayStringMatch[0]);
            suggestions = [...new Set(parsedSuggestions)];
        }
    } catch (e) {
        console.error("❌ Error parsing suggestions from AI:", e.message);
    }

    conversationCache.set(conversationId, { question: userQuestion, answer: mainAnswer });

    return {
        text: mainAnswer,
        blocks: [
            { type: "section", text: { type: "mrkdwn", text: mainAnswer } },
            ...(suggestions.length > 0 ? [
                { type: "divider" },
                { type: "section", text: { type: "mrkdwn", text: "You might also want to ask:" } },
                {
                    type: "actions",
                    elements: suggestions.slice(0, 3).map(q => {
                        const buttonText = q.length > 75 ? q.substring(0, 72) + "..." : q;
                        return { type: "button", text: { type: "plain_text", text: buttonText, emoji: true }, value: q };
                    })
                }
            ] : [])
        ]
    };
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
    const [googleContent, notionContent] = await Promise.all([ getGoogleDocContent(googleDocId), getNotionPageContent(notionPageId) ]);
    indexedKnowledge = `--- GOOGLE DOCS ---\n${googleContent}\n\n--- NOTION ---\n${notionContent}`;
    console.log("✅ INDEXING COMPLETE!");
    say("All knowledge sources have been successfully indexed and are ready for questions.");
});

app.event('app_mention', async ({ event, say }) => {
    try {
        const userQuestion = event.text.replace(/<@.*?>/g, '').trim();
        const conversationId = `convo-${event.user}-${event.channel}`;
        const messagePayload = await processQuestion(userQuestion, conversationId);
        await say(messagePayload);
    } catch (error) {
        console.error("❌ Error in app_mention:", error);
        await say("Sorry, I encountered an error while thinking. Please try again.");
    }
});

app.action(/.*/, async ({ action, ack, say, body }) => {
    await ack();
    try {
        const userQuestion = action.value;
        const conversationId = `convo-${body.user.id}-${body.channel.id}`;
        const messagePayload = await processQuestion(userQuestion, conversationId);
        await say(messagePayload);
    } catch (error) {
        console.error("❌ Error in app.action:", error);
        await say("Sorry, I encountered an error. Please try asking your question again.");
    }
});

(async () => {
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Bolt app is running on port ${port}!`);
})();