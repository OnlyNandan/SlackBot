require('dotenv').config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const { Client } = require("@notionhq/client");
const NodeCache = require("node-cache");

const conversationCache = new NodeCache({ stdTTL: 600 });

async function getGoogleDocContent(documentId) {
    if (!documentId) {
        console.error("❌ Google Doc ID is missing from environment variables.");
        return "Error: Google Doc ID is not configured.";
    }
    // ... rest of the function is the same
}

async function getNotionPageContent(pageId) {
    if (!pageId) {
        console.error("❌ Notion Page ID is missing from environment variables.");
        return "Error: Notion Page ID is not configured.";
    }
    if (!process.env.NOTION_API_KEY) {
        console.error("❌ Notion API Key is missing from environment variables.");
        return "Error: Notion API Key is not configured.";
    }
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    try {
        console.log(`Fetching content from Notion Page ID: ${pageId}`); // This is the log we aren't seeing
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

// ... rest of the file is the same, but I'll paste it all for clarity

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
receiver.router.get('/', (req, res) => { res.status(200).send('I am alive and ready to serve!'); });

const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver: receiver });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.command('/index', async ({ command, ack, say }) => {
    // ...
});

app.event('app_mention', async ({ event, client, say }) => {
    const userQuestion = event.text.replace(/<@.*?>/g, '').trim();
    const conversationId = `convo-${event.user}-${event.channel}`;
    const previousConversation = conversationCache.get(conversationId);

    try {
        const googleDocId = process.env.GOOGLE_DOC_ID;
        const notionPageId = process.env.NOTION_PAGE_ID;

        // NEW DEBUGGING LOGS
        console.log(`Preparing to fetch. Google Doc ID found: ${!!googleDocId}, Notion Page ID found: ${!!notionPageId}`);
        console.log(`Notion API Key exists: ${!!process.env.NOTION_API_KEY}`);

        console.log("Fetching content from Google Docs and Notion in parallel...");
        const [googleContent, notionContent] = await Promise.all([
            getGoogleDocContent(googleDocId),
            getNotionPageContent(notionPageId)
        ]);

        const contextDocument = `

          ${googleContent}
  
          ${notionContent}
        `;
        
        // ... rest of the function is the same
    } catch (error) {
        // ...
    }
});


(async () => {
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Bolt app is running on port ${port}!`);
})();