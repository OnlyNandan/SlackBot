/**
 * @file A sophisticated Slack Bot that integrates with Google Docs, Notion, URLs, and Google's Generative AI
 * to answer user questions based on a knowledge base.
 * @author Your Name
 * @version 3.0.0
 */

// -----------------------------------------------------------------------------
// IMPORTS AND INITIALIZATION
// -----------------------------------------------------------------------------

require('dotenv').config();
const { App, ExpressReceiver, LogLevel } = require("@slack/bolt");
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { google } = require('googleapis');
const { Client } = require("@notionhq/client");
const NodeCache = require("node-cache");
const axios = require('axios');

// -----------------------------------------------------------------------------
// CONSTANTS AND CONFIGURATION
// -----------------------------------------------------------------------------

// Environment variable validation
const requiredEnvVars = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'GOOGLE_API_KEY'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`FATAL ERROR: Environment variable ${envVar} is not set.`);
    }
}

const {
    SLACK_SIGNING_SECRET,
    SLACK_BOT_TOKEN,
    GOOGLE_API_KEY,
    GOOGLE_DOC_ID,
    NOTION_PAGE_ID,
    NOTION_API_KEY,
    KNOWLEDGE_URL,
    GOOGLE_APPLICATION_CREDENTIALS,
    GOOGLE_CREDENTIALS_JSON,
    PORT = 3000,
    LOG_LEVEL = 'info'
} = process.env;

// Initialize a cache for conversation history. TTL is 10 minutes (600 seconds).
const conversationCache = new NodeCache({ stdTTL: 600 });

// Global variable to hold the indexed knowledge content.
let indexedKnowledge = "No knowledge has been indexed yet. Please run the `/index` command.";

// -----------------------------------------------------------------------------
// KNOWLEDGE SOURCE MODULE
// -----------------------------------------------------------------------------

/**
 * Manages fetching content from various knowledge sources.
 */
const KnowledgeSource = {
    getGoogleDocContent: async (documentId) => {
        if (!documentId) {
            console.warn("⚠️ Google Doc ID is not configured. Skipping.");
            return "";
        }
        try {
            const auth = GOOGLE_CREDENTIALS_JSON
                ? new google.auth.GoogleAuth({ credentials: JSON.parse(GOOGLE_CREDENTIALS_JSON), scopes: ['https://www.googleapis.com/auth/documents.readonly'] })
                : new google.auth.GoogleAuth({ keyFile: GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/documents.readonly'] });
            const authClient = await auth.getClient();
            const docs = google.docs({ version: 'v1', auth: authClient });
            const { data } = await docs.documents.get({ documentId });
            return data.body.content.filter(e => e.paragraph).flatMap(e => e.paragraph.elements).filter(e => e.textRun && e.textRun.content).map(e => e.textRun.content).join('');
        } catch (error) {
            console.error("❌ Error fetching from Google Docs:", error.message);
            throw new Error("Could not retrieve the Google Docs document. Please check permissions and ID.");
        }
    },

    getNotionPageContent: async (pageId) => {
        if (!pageId || !NOTION_API_KEY) {
            console.warn("⚠️ Notion Page ID or API Key is missing. Skipping.");
            return "";
        }
        const notion = new Client({ auth: NOTION_API_KEY });
        try {
            const { results } = await notion.blocks.children.list({ block_id: pageId });
            return results.filter(b => b.type && b[b.type].rich_text).map(b => b[b.type].rich_text.map(rt => rt.plain_text).join('')).join('\n');
        } catch (error) {
            console.error("❌ Error fetching from Notion:", error.message);
            throw new Error("Could not retrieve the Notion document. Please check API key, permissions, and ID.");
        }
    },

    getURLContent: async (url) => {
        if (!url) {
            console.warn("⚠️ Knowledge URL is not configured. Skipping.");
            return "";
        }
        try {
            const { data } = await axios.get(url, { headers: { 'Accept': 'text/plain, application/json' }});
            // Basic content extraction. For complex HTML, a library like Cheerio would be better.
            return typeof data === 'object' ? JSON.stringify(data, null, 2) : data.toString();
        } catch (error) {
            console.error(`❌ Error fetching from URL (${url}):`, error.message);
            throw new Error(`Could not retrieve content from the URL. Please check the URL and its accessibility.`);
        }
    },

    indexAll: async () => {
        console.log("🚀 Starting indexing process...");
        const sources = [
            KnowledgeSource.getGoogleDocContent(GOOGLE_DOC_ID),
            KnowledgeSource.getNotionPageContent(NOTION_PAGE_ID),
            KnowledgeSource.getURLContent(KNOWLEDGE_URL)
        ];
        const [googleContent, notionContent, urlContent] = await Promise.all(sources.map(p => p.catch(e => { console.error(e.message); return ""; })));

        if (!googleContent && !notionContent && !urlContent) {
            indexedKnowledge = "Failed to index any documents. Please check the logs for errors.";
            console.error("❌ INDEXING FAILED! No content was retrieved.");
            return indexedKnowledge;
        }

        indexedKnowledge = `--- GOOGLE DOCS ---\n${googleContent}\n\n--- NOTION ---\n${notionContent}\n\n--- URL CONTENT ---\n${urlContent}`;
        console.log("✅ Indexing complete!");
        return "All knowledge sources have been successfully indexed.";
    }
};

// -----------------------------------------------------------------------------
// AI SERVICE MODULE
// -----------------------------------------------------------------------------

/**
 * Handles interactions with the Google Generative AI.
 */
const AIService = {
    model: null,
    initialize: () => {
        const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        AIService.model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: "You are a helpful and friendly assistant named 'KnowledgeBot'. You answer questions based *only* on the provided context. You are concise, professional, and you never mention the document you're using.",
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            ],
        });
        console.log("🤖 AI Service Initialized.");
    },

    generateAnswer: async (userQuestion, previousConversation) => {
        const prompt = `
          PREVIOUS CONTEXT: ${previousConversation ? `User: "${previousConversation.question}". You: "${previousConversation.answer}"` : "None."}
          ---
          DOCUMENT: ${indexedKnowledge}
          ---
          NEW QUESTION: "${userQuestion}"`;
        try {
            const result = await AIService.model.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            console.error("❌ Error generating answer from AI:", error);
            return "Sorry, I had trouble formulating a response.";
        }
    },

    generateSuggestions: async (userQuestion, mainAnswer) => {
        const prompt = `
            You are a suggestion generator. Your task is to suggest three distinct, insightful follow-up questions.
            Rules:
            1. Suggestions MUST be answerable using ONLY the provided DOCUMENT.
            2. Do not suggest questions if the answer is obvious from the original ANSWER.
            3. Questions should be things a curious user would naturally ask next.
            4. Return ONLY a JavaScript-style array of strings, like ["question 1", "question 2", "question 3"].

            DOCUMENT:
            ---
            ${indexedKnowledge}
            ---
            ORIGINAL QUESTION: "${userQuestion}"
            ORIGINAL ANSWER: "${mainAnswer}"`;
        try {
            const result = await AIService.model.generateContent(prompt);
            const text = result.response.text();
            const arrayMatch = text.match(/\[\s*".*?"\s*(,\s*".*?"\s*)*\]/s);
            return arrayMatch ? JSON.parse(arrayMatch[0]) : [];
        } catch (error) {
            console.error("❌ Error generating suggestions from AI:", error);
            return [];
        }
    }
};

// -----------------------------------------------------------------------------
// SLACK SERVICE MODULE
// -----------------------------------------------------------------------------

/**
 * Manages all interactions with the Slack API for better modularity.
 */
const SlackService = {
    client: null,
    initialize: (appInstance) => {
        SlackService.client = appInstance.client;
        console.log("🤝 Slack Service Initialized.");
    },
    postMessage: async (channelId, text) => {
        const result = await SlackService.client.chat.postMessage({ channel: channelId, text });
        return result.ts; // Return the timestamp for potential updates
    },
    updateMessage: async (channelId, ts, payload) => {
        await SlackService.client.chat.update({ channel: channelId, ts, text: payload.text, blocks: payload.blocks });
    },
    buildMessagePayload: (text, suggestions = []) => {
        const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
        if (suggestions.length > 0) {
            blocks.push({ type: "divider" });
            blocks.push({ type: "section", text: { type: "mrkdwn", text: "*You might also want to ask:*" } });
            blocks.push({
                type: "actions",
                elements: [...new Set(suggestions)].slice(0, 3).map(q => ({
                    type: "button",
                    text: { type: "plain_text", text: q.length > 75 ? q.substring(0, 72) + "..." : q, emoji: true },
                    value: q
                }))
            });
        }
        return { text, blocks };
    }
};

// -----------------------------------------------------------------------------
// SLACK APPLICATION LOGIC
// -----------------------------------------------------------------------------

const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
const app = new App({ token: SLACK_BOT_TOKEN, receiver, logLevel: LogLevel[LOG_LEVEL.toUpperCase()] || LogLevel.INFO });

/**
 * Centralized logic for processing a question.
 */
async function handleQuestion(userQuestion, userId, channelId) {
    let thinkingMessageTs;
    try {
        thinkingMessageTs = await SlackService.postMessage(channelId, `🤔 Thinking about your question...`);
        const conversationId = `convo-${userId}-${channelId}`;
        const previousConversation = conversationCache.get(conversationId);
        const mainAnswer = await AIService.generateAnswer(userQuestion, previousConversation);
        let suggestions = [];
        if (!mainAnswer.includes("I do not have information")) {
            suggestions = await AIService.generateSuggestions(userQuestion, mainAnswer);
        }
        conversationCache.set(conversationId, { question: userQuestion, answer: mainAnswer });
        const payload = SlackService.buildMessagePayload(mainAnswer, suggestions);
        await SlackService.updateMessage(channelId, thinkingMessageTs, payload);
    } catch (error) {
        console.error("❌ Error in handleQuestion:", error);
        const errorMessage = "I'm sorry, but I encountered an internal error. The engineering team has been notified.";
        if (thinkingMessageTs) {
            await SlackService.updateMessage(channelId, thinkingMessageTs, { text: errorMessage, blocks: [] });
        } else {
            // Fallback if the initial message failed
            await SlackService.client.chat.postMessage({ channel: channelId, text: errorMessage });
        }
    }
}

// --- Slack Event Handlers ---

receiver.router.get('/', (req, res) => res.status(200).send('Slack Bot is alive and ready to serve!'));

app.command('/index', async ({ command, ack, say }) => {
    await ack();
    await say(`Got it, <@${command.user_id}>! Starting the indexing process. This might take a moment...`);
    const resultMessage = await KnowledgeSource.indexAll();
    await say(resultMessage);
});

app.command('/help', async ({ command, ack, say }) => {
    await ack();
    const helpText = `
Hello <@${command.user_id}>! I'm KnowledgeBot. Here's how I can help:

*❓ How to ask questions*
Simply @mention me with your question (e.g., \`@KnowledgeBot what is our vacation policy?\`).

*🤖 Available Commands*
\`/index\`: Manually re-indexes all knowledge sources.
\`/help\`: Shows this help message.

*📚 My Knowledge Sources*
${GOOGLE_DOC_ID ? '• A Google Document\n' : ''}${NOTION_PAGE_ID ? '• A Notion Page\n' : ''}${KNOWLEDGE_URL ? '• A Web URL\n' : ''}${!GOOGLE_DOC_ID && !NOTION_PAGE_ID && !KNOWLEDGE_URL ? '• No knowledge sources are configured.' : ''}
    `.trim().replace(/^\s+/gm, '');
    await say({ text: "Help Information", blocks: [{ type: 'section', text: { type: 'mrkdwn', text: helpText } }] });
});

app.event('app_mention', async ({ event, say }) => {
    const userQuestion = event.text.replace(/<@.*?>/g, '').trim();
    if (!userQuestion) {
        await say("Hello! How can I help you today? Ask me a question about our knowledge base.");
        return;
    }
    await handleQuestion(userQuestion, event.user, event.channel);
});

app.action(/.*/, async ({ action, ack, body }) => {
    await ack();
    await handleQuestion(action.value, body.user.id, body.channel.id);
});

// -----------------------------------------------------------------------------
// APPLICATION STARTUP
// -----------------------------------------------------------------------------

(async () => {
    try {
        await app.start(PORT);
        AIService.initialize();
        SlackService.initialize(app);
        console.log(`⚡️ Bolt app is running on port ${PORT}!`);
        if (GOOGLE_DOC_ID || NOTION_PAGE_ID || KNOWLEDGE_URL) {
            await KnowledgeSource.indexAll();
        }
    } catch (error) {
        console.error("❌ Failed to start the application:", error);
        process.exit(1);
    }
})();
