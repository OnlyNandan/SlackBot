require('dotenv').config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const { Client } = require("@notionhq/client");
const NodeCache = require("node-cache");

const conversationCache = new NodeCache({ stdTTL: 600 });

async function getGoogleDocContent(documentId) {
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
    say(`Got it! Starting the indexing process now... This can take a moment.`);
    console.log(`✅ /index command received from user ${command.user_name}.`);
});

app.event('app_mention', async ({ event, client, say }) => {
    const userQuestion = event.text.replace(/<@.*?>/g, '').trim();
    const conversationId = `convo-${event.user}-${event.channel}`;
    const previousConversation = conversationCache.get(conversationId);

    try {
        const documentId = process.env.GOOGLE_DOC_ID; 
        const contextDocument = await getGoogleDocContent(documentId);

        if (contextDocument.startsWith("Error:")) {
            await say(contextDocument);
            return;
        }
        
        let prompt = `
          You are a helpful assistant. Answer the following question based *only* on the provided document.
          If the answer is not found in the document, say "I do not have information on that."

          DOCUMENT:
          ---
          ${contextDocument}
          ---
        `;

        if (previousConversation) {
            prompt += `
              For context, here was the previous question and answer:
              PREVIOUS QUESTION: "${previousConversation.question}"
              PREVIOUS ANSWER: "${previousConversation.answer}"
              ---
            `;
        }

        prompt += `NEW QUESTION: "${userQuestion}"`;

        const result = await model.generateContent(prompt);
        const aiResponseText = result.response.text();

        conversationCache.set(conversationId, { question: userQuestion, answer: aiResponseText });

        await say(aiResponseText);

    } catch (error) {
        console.error("❌ Error processing AI request:", error);
        await say("Sorry, I encountered an error while thinking. Please try again.");
    }
});

(async () => {
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Bolt app is running on port ${port}!`);
})();