/**
 * @file A sophisticated Slack Bot that uses OpenAI as the primary AI with a fallback to Gemini.
 * @author Your Name
 * @version 5.0.0
 */

// -----------------------------------------------------------------------------
// IMPORTS AND INITIALIZATION
// -----------------------------------------------------------------------------

require('dotenv').config();
const { App, ExpressReceiver, LogLevel } = require("@slack/bolt");
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { google } = require('googleapis');
const { Client } = require("@notionhq/client");
const OpenAI = require('openai');
const NodeCache = require("node-cache");
const axios =require('axios');

// -----------------------------------------------------------------------------
// CONSTANTS AND CONFIGURATION
// -----------------------------------------------------------------------------

const requiredEnvVars = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'GOOGLE_API_KEY', 'OPENAI_API_KEY'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`FATAL ERROR: Environment variable ${envVar} is not set.`);
    }
}

const {
    SLACK_SIGNING_SECRET,
    SLACK_BOT_TOKEN,
    GOOGLE_API_KEY,
    OPENAI_API_KEY,
    GOOGLE_DOC_ID,
    NOTION_PAGE_ID,
    NOTION_API_KEY,
    KNOWLEDGE_URL,
    GOOGLE_APPLICATION_CREDENTIALS,
    GOOGLE_CREDENTIALS_JSON,
    PORT = 3000,
    LOG_LEVEL = 'info'
} = process.env;

const conversationCache = new NodeCache({ stdTTL: 600 });
let indexedKnowledge = "No knowledge has been indexed yet. Please run the `/index` command.";

// -----------------------------------------------------------------------------
// KNOWLEDGE SOURCE MODULE
// -----------------------------------------------------------------------------

const KnowledgeSource = {
    // This module remains unchanged.
    getGoogleDocContent: async (documentId) => {
        if (!documentId) return "";
        try {
            const auth = GOOGLE_CREDENTIALS_JSON
                ? new google.auth.GoogleAuth({ credentials: JSON.parse(GOOGLE_CREDENTIALS_JSON), scopes: ['https://www.googleapis.com/auth/documents.readonly'] })
                : new google.auth.GoogleAuth({ keyFile: GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/documents.readonly'] });
            const docs = google.docs({ version: 'v1', auth: await auth.getClient() });
            const { data } = await docs.documents.get({ documentId });
            return data.body.content.filter(e => e.paragraph).flatMap(e => e.paragraph.elements).filter(e => e.textRun && e.textRun.content).map(e => e.textRun.content).join('');
        } catch (error) {
            console.error("❌ Error fetching from Google Docs:", error.message);
            throw new Error("Could not retrieve the Google Docs document.");
        }
    },
    getNotionPageContent: async (pageId) => {
        if (!pageId || !NOTION_API_KEY) return "";
        const notion = new Client({ auth: NOTION_API_KEY });
        try {
            const { results } = await notion.blocks.children.list({ block_id: pageId });
            return results.filter(b => b.type && b[b.type].rich_text).map(b => b[b.type].rich_text.map(rt => rt.plain_text).join('')).join('\n');
        } catch (error) {
            console.error("❌ Error fetching from Notion:", error.message);
            throw new Error("Could not retrieve the Notion document.");
        }
    },
    getURLContent: async (url) => {
        if (!url) return "";
        try {
            const { data } = await axios.get(url, { headers: { 'Accept': 'text/plain' }});
            return typeof data === 'object' ? JSON.stringify(data) : String(data);
        } catch (error) {
            console.error(`❌ Error fetching from URL (${url}):`, error.message);
            throw new Error(`Could not retrieve content from the URL.`);
        }
    },
    indexAll: async () => {
        console.log("🚀 Starting indexing process...");
        const sources = [
            KnowledgeSource.getGoogleDocContent(GOOGLE_DOC_ID),
            KnowledgeSource.getNotionPageContent(NOTION_PAGE_ID),
            KnowledgeSource.getURLContent(KNOWLEDGE_URL)
        ];
        const results = await Promise.all(sources.map(p => p.catch(e => { console.error(e.message); return ""; })));
        const [googleContent, notionContent, urlContent] = results;

        if (!googleContent && !notionContent && !urlContent) {
            indexedKnowledge = "Failed to index any documents. Please check the logs for errors.";
            console.error("❌ INDEXING FAILED! No content was retrieved.");
        } else {
            indexedKnowledge = `--- GOOGLE DOCS ---\n${googleContent}\n\n--- NOTION ---\n${notionContent}\n\n--- URL CONTENT ---\n${urlContent}`;
            console.log("✅ Indexing complete!");
        }
        return indexedKnowledge.startsWith("Failed") ? indexedKnowledge : "All knowledge sources have been successfully indexed.";
    }
};

// -----------------------------------------------------------------------------
// AI SERVICE MODULE (OpenAI Primary, Gemini Fallback)
// -----------------------------------------------------------------------------

const AIService = {
    openai: null,
    geminiModel: null,

    initialize: () => {
        if (OPENAI_API_KEY) {
            AIService.openai = new OpenAI({ apiKey: OPENAI_API_KEY });
            console.log("🤖 Primary AI Service (OpenAI) Initialized.");
        } else {
            console.error("❌ FATAL: OpenAI API Key not found. The primary AI service is disabled.");
        }
        
        const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        AIService.geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        console.log("🤖 Fallback AI Service (Gemini) Initialized.");
    },

    isRateLimitError: (error) => {
        return error.message.includes('429') || (error.error && error.error.code === 'rate_limit_exceeded');
    },
    
    // --- Primary Functions (Try OpenAI, fallback to Gemini) ---

    generateAnswer: async (userQuestion, previousConversation) => {
        const prompt = `You are a helpful and friendly assistant named 'KnowledgeBot'. You answer questions based *only* on the provided context. You are concise, professional, and you never mention the document you're using. If the answer is not in the document, say 'I do not have information on that.'\n\nPREVIOUS CONTEXT: ${previousConversation ? `User: "${previousConversation.question}". You: "${previousConversation.answer}"` : "None."}\n---\nDOCUMENT: ${indexedKnowledge}\n---\nNEW QUESTION: "${userQuestion}"`;
        try {
            if (!AIService.openai) throw new Error("OpenAI service not initialized.");
            return await AIService.generateAnswerWithOpenAI(prompt);
        } catch (error) {
            console.error("❌ Error with OpenAI (Answer):", error.message);
            if (AIService.isRateLimitError(error)) {
                console.log("🔀 OpenAI rate limited. Switching to Gemini for answer...");
                return await AIService.generateAnswerWithGemini(prompt);
            }
            return "My primary AI service seems to be having trouble. Please try again later.";
        }
    },

    generateSuggestions: async (userQuestion, mainAnswer) => {
        const prompt = `You are a suggestion generator. Your task is to suggest three distinct, insightful follow-up questions. Rules: 1. Suggestions MUST be answerable using ONLY the provided DOCUMENT. 2. Do not suggest questions if the answer is obvious from the original ANSWER. 3. Questions should be things a curious user would naturally ask next. 4. Return ONLY a valid JSON object with a single key "suggestions" which contains an array of strings. Example: { "suggestions": ["question 1", "question 2", "question 3"] }\n\nDOCUMENT:\n---\n${indexedKnowledge}\n---\nORIGINAL QUESTION: "${userQuestion}"\nORIGINAL ANSWER: "${mainAnswer}"`;
        try {
            if (!AIService.openai) throw new Error("OpenAI service not initialized.");
            return await AIService.generateSuggestionsWithOpenAI(prompt);
        } catch (error) {
            console.error("❌ Error generating suggestions with OpenAI:", error.message);
            if (AIService.isRateLimitError(error)) {
                console.log("🔀 OpenAI rate limited. Switching to Gemini for suggestions...");
                return await AIService.generateSuggestionsWithGemini(prompt);
            }
            return []; // Fail silently for suggestions
        }
    },

    // --- Specific Implementations for each AI ---

    generateAnswerWithOpenAI: async (prompt) => {
        const completion = await AIService.openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
        });
        return completion.choices[0].message.content;
    },

    generateAnswerWithGemini: async (prompt) => {
        try {
            const result = await AIService.geminiModel.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            console.error("❌ Error generating answer from Gemini (Fallback):", error);
            return "My fallback AI service also seems to be having trouble. Please try again later.";
        }
    },
    
    generateSuggestionsWithOpenAI: async (prompt) => {
        const completion = await AIService.openai.chat.completions.create({
            model: "gpt-3.5-turbo-1106",
            messages: [{ role: "system", content: "You are a suggestion generator." }, { role: "user", content: prompt }],
            response_format: { type: "json_object" },
        });
        const content = JSON.parse(completion.choices[0].message.content);
        return Array.isArray(content.suggestions) ? content.suggestions : [];
    },

    generateSuggestionsWithGemini: async (prompt) => {
        try {
            const result = await AIService.geminiModel.generateContent(prompt);
            const text = result.response.text();
            const arrayMatch = text.match(/\[\s*".*?"\s*(,\s*".*?"\s*)*\]/s);
            return arrayMatch ? JSON.parse(arrayMatch[0]) : [];
        } catch (error) {
            console.error("❌ Error generating suggestions from Gemini (Fallback):", error);
            return []; // Fail silently
        }
    }
};

// -----------------------------------------------------------------------------
// SLACK SERVICE AND APP LOGIC
// -----------------------------------------------------------------------------

const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
const app = new App({ token: SLACK_BOT_TOKEN, receiver, logLevel: LogLevel[LOG_LEVEL.toUpperCase()] || LogLevel.INFO });

const SlackService = {
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

async function handleQuestion(userQuestion, userId, channelId) {
    let thinkingMessageTs;
    try {
        thinkingMessageTs = await app.client.chat.postMessage({ channel: channelId, text: `🤔 Thinking about your question...`});
        const conversationId = `convo-${userId}-${channelId}`;
        const previousConversation = conversationCache.get(conversationId);
        
        const mainAnswer = await AIService.generateAnswer(userQuestion, previousConversation);
        
        let suggestions = [];
        if (!mainAnswer.includes("I do not have information") && !mainAnswer.includes("having trouble")) {
            suggestions = await AIService.generateSuggestions(userQuestion, mainAnswer);
        }
        
        conversationCache.set(conversationId, { question: userQuestion, answer: mainAnswer });
        
        const payload = SlackService.buildMessagePayload(mainAnswer, suggestions);
        await app.client.chat.update({ channel: channelId, ts: thinkingMessageTs.ts, text: payload.text, blocks: payload.blocks });
    } catch (error) {
        console.error("❌ Fatal Error in handleQuestion:", error);
        const errorMessage = "I'm sorry, but I encountered a critical error. The engineering team has been notified.";
        if (thinkingMessageTs) {
            await app.client.chat.update({ channel: channelId, ts: thinkingMessageTs.ts, text: errorMessage, blocks: [] });
        } else {
            await app.client.chat.postMessage({ channel: channelId, text: errorMessage });
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
    const helpText = `Hello <@${command.user_id}>! I'm KnowledgeBot. Here's how I can help:\n\n*❓ How to ask questions*\nSimply @mention me with your question (e.g., \`@KnowledgeBot what is our vacation policy?\`).\n\n*🤖 Available Commands*\n\`/index\`: Manually re-indexes all knowledge sources.\n\`/help\`: Shows this help message.\n\n*📚 My Knowledge Sources*\n${GOOGLE_DOC_ID ? '• A Google Document\n' : ''}${NOTION_PAGE_ID ? '• A Notion Page\n' : ''}${KNOWLEDGE_URL ? '• A Web URL\n' : ''}${!GOOGLE_DOC_ID && !NOTION_PAGE_ID && !KNOWLEDGE_URL ? '• No knowledge sources are configured.' : ''}`.trim().replace(/^\s+/gm, '');
    await say({ text: "Help Information", blocks: [{ type: 'section', text: { type: 'mrkdwn', text: helpText } }] });
});

app.event('app_mention', async ({ event }) => {
    const userQuestion = event.text.replace(/<@.*?>/g, '').trim();
    if (!userQuestion) {
        await app.client.chat.postMessage({ channel: event.channel, text: "Hello! How can I help you today? Ask me a question about our knowledge base." });
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
        console.log(`⚡️ Bolt app is running on port ${PORT}!`);
        if (GOOGLE_DOC_ID || NOTION_PAGE_ID || KNOWLEDGE_URL) {
            await KnowledgeSource.indexAll();
        }
    } catch (error) {
        console.error("❌ Failed to start the application:", error);
        process.exit(1);
    }
})();
