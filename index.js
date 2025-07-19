/**
 * @file A sophisticated, hackathon-winning Slack Bot with multimodal capabilities, dynamic personas, and deep contextual actions.
 * @author Your Name
 * @version 10.0.0
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
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const NodeCache = require('node-cache');

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
    FEEDBACK_CHANNEL_ID,
    GOOGLE_APPLICATION_CREDENTIALS,
    GOOGLE_CREDENTIALS_JSON,
    PORT = 3000,
    LOG_LEVEL = 'info'
} = process.env;

let indexedKnowledge = "No knowledge has been indexed yet. Please run the `/index` command.";
const STATS_FILE_PATH = path.join(__dirname, 'bot_stats.json');
const CONVERSATION_CACHE = new NodeCache({ stdTTL: 600 });
let currentPersona = "a helpful and friendly assistant named 'KnowledgeBot'";

let stats = {
    questionsAsked: 0,
    fallbacksUsed: 0,
    summariesGenerated: 0,
    digestsGenerated: 0,
    directAsks: 0,
    imageAsks: 0,
    feedbackReceived: 0,
    personasSet: 0,
    startTime: new Date().toISOString()
};

// -----------------------------------------------------------------------------
// PERSISTENCE FUNCTIONS
// -----------------------------------------------------------------------------

async function saveStats() {
    try {
        await fs.writeFile(STATS_FILE_PATH, JSON.stringify(stats, null, 2));
    } catch (error) {
        console.error("❌ Error saving stats:", error);
    }
}

async function loadStats() {
    try {
        const data = await fs.readFile(STATS_FILE_PATH, 'utf8');
        stats = JSON.parse(data);
        console.log("✅ Successfully loaded persistent stats.");
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log("📊 No stats file found. Starting with fresh analytics.");
            await saveStats();
        } else {
            console.error("❌ Error loading stats:", error);
        }
    }
}

// -----------------------------------------------------------------------------
// KNOWLEDGE SOURCE MODULE
// -----------------------------------------------------------------------------

const KnowledgeSource = {
    getGoogleDocContent: async (documentId) => {
        if (!documentId) return "";
        try {
            const auth = GOOGLE_CREDENTIALS_JSON ? new google.auth.GoogleAuth({ credentials: JSON.parse(GOOGLE_CREDENTIALS_JSON), scopes: ['https://www.googleapis.com/auth/documents.readonly'] }) : new google.auth.GoogleAuth({ keyFile: GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/documents.readonly'] });
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
            const { data } = await axios.get(url, { headers: { 'Accept': 'text/plain' } });
            return typeof data === 'object' ? JSON.stringify(data) : String(data);
        } catch (error) {
            console.error(`❌ Error fetching from URL (${url}):`, error.message);
            throw new Error(`Could not retrieve content from the URL.`);
        }
    },
    indexAll: async () => {
        console.log("🚀 Starting indexing process...");
        const sources = [KnowledgeSource.getGoogleDocContent(GOOGLE_DOC_ID), KnowledgeSource.getNotionPageContent(NOTION_PAGE_ID), KnowledgeSource.getURLContent(KNOWLEDGE_URL)];
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
// AI SERVICE MODULE
// -----------------------------------------------------------------------------

const AIService = {
    geminiModel: null,
    geminiVisionModel: null,
    openai: null,

    initialize: () => {
        const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        ];
        AIService.geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash", safetySettings });
        AIService.geminiVisionModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro", safetySettings });
        console.log("🤖 Primary AI Services (Gemini Text & Vision) Initialized.");

        if (OPENAI_API_KEY) {
            AIService.openai = new OpenAI({ apiKey: OPENAI_API_KEY });
            console.log("🤖 Fallback AI Service (OpenAI) Initialized.");
        } else {
            console.warn("⚠️ OpenAI API Key not found. Fallback AI service is disabled.");
        }
    },

    isRateLimitError: (error) => (error.message || '').includes('429') || (error.error && error.error.code === 'rate_limit_exceeded'),

    generateAnswer: async (prompt, useFallback = false) => {
        try {
            if (useFallback) {
                stats.fallbacksUsed++;
                await saveStats();
                return await AIService.generateAnswerWithOpenAI(prompt);
            }
            return await AIService.generateAnswerWithGemini(prompt);
        } catch (error) {
            console.error(`❌ Error with ${useFallback ? 'OpenAI' : 'Gemini'}:`, error);
            if (AIService.isRateLimitError(error) && !useFallback) {
                console.log("🔀 Gemini rate limited. Switching to OpenAI...");
                return await AIService.generateAnswer(prompt, true);
            }
            return "Sorry, I had trouble formulating a response. The AI may have refused to answer due to its safety policies.";
        }
    },
    
    generateAnswerFromImage: async (prompt, imageUrl) => {
        stats.imageAsks++;
        await saveStats();
        try {
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const mimeType = response.headers['content-type'];
            const imagePart = {
                inlineData: {
                    data: Buffer.from(response.data).toString('base64'),
                    mimeType
                }
            };
            const result = await AIService.geminiVisionModel.generateContent([prompt, imagePart]);
            return result.response.text();
        } catch (error) {
            console.error("❌ Error generating answer from image:", error);
            return "Sorry, I couldn't analyze the image. Please ensure the URL is correct and publicly accessible.";
        }
    },

    generateSuggestions: async (prompt) => {
        try {
            const result = await AIService.geminiModel.generateContent(prompt);
            const text = result.response.text();
            if (!text) return [];
            const arrayMatch = text.match(/\[\s*".*?"\s*(,\s*".*?"\s*)*\]/s);
            return arrayMatch ? JSON.parse(arrayMatch[0]) : [];
        } catch (error) {
            console.error("❌ Error generating suggestions:", error);
            return [];
        }
    },
    
    generateAnswerWithGemini: async (prompt) => {
        const result = await AIService.geminiModel.generateContent(prompt);
        const response = result.response;
        if (response.promptFeedback && response.promptFeedback.blockReason) {
            throw new Error(`Gemini response was blocked. Reason: ${response.promptFeedback.blockReason}.`);
        }
        const text = response.text();
        if (!text) throw new Error("Gemini returned an empty response.");
        return text;
    },

    generateAnswerWithOpenAI: async (prompt) => {
        const completion = await AIService.openai.chat.completions.create({ model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }] });
        return completion.choices[0].message.content;
    }
};

// -----------------------------------------------------------------------------
// SLACK SERVICE AND APP LOGIC
// -----------------------------------------------------------------------------

const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
const app = new App({ token: SLACK_BOT_TOKEN, receiver, logLevel: LogLevel[LOG_LEVEL.toUpperCase()] || LogLevel.INFO });

function buildMessagePayload(text, suggestions = []) {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
    if (suggestions.length > 0) {
        blocks.push({ type: "divider" });
        blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "*You might also want to ask:*" }] });
        suggestions.slice(0, 5).forEach(q => {
            blocks.push({ type: "section", text: { type: "mrkdwn", text: `>_${q}_` } });
        });
    }
    return { text, blocks };
}

async function handleQuestion(userQuestion, channelId, userId, documentOverride = null) {
    stats.questionsAsked++;
    await saveStats();
    const thinkingMessage = await app.client.chat.postMessage({ channel: channelId, text: `🤔 Thinking...` });

    try {
        const conversationId = `convo-${userId}-${channelId}`;
        const previousConversation = CONVERSATION_CACHE.get(conversationId);
        
        const document = documentOverride || indexedKnowledge;
        const prompt = `You are ${currentPersona}. Answer the NEW QUESTION based on the DOCUMENT and PREVIOUS CONTEXT.\n\nPREVIOUS CONTEXT:\n${previousConversation ? `User: "${previousConversation.question}". You: "${previousConversation.answer}"` : "None."}\n---\nDOCUMENT:\n${document}\n---\nNEW QUESTION:\n"${userQuestion}"`;
        
        const mainAnswer = await AIService.generateAnswer(prompt);
        
        let suggestions = [];
        if (!mainAnswer.includes("I do not have information")) {
            const suggestionPrompt = `Based on the answer "${mainAnswer}", suggest three follow-up questions. Return a JavaScript array of strings.`;
            suggestions = await AIService.generateSuggestions(suggestionPrompt);
        }
        
        CONVERSATION_CACHE.set(conversationId, { question: userQuestion, answer: mainAnswer });
        
        const payload = buildMessagePayload(mainAnswer, suggestions);
        await app.client.chat.update({ channel: channelId, ts: thinkingMessage.ts, ...payload });

    } catch (error) {
        console.error("❌ Fatal Error in handleQuestion:", error);
        await app.client.chat.update({ channel: channelId, ts: thinkingMessage.ts, text: "I'm sorry, but I encountered a critical error." });
    }
}

// --- Slack Event Handlers ---

receiver.router.get('/', (req, res) => res.status(200).send('Slack Bot is alive and ready to serve!'));

app.command('/index', async ({ command, ack, say }) => {
    await ack();
    const resultMessage = await KnowledgeSource.indexAll();
    await say(resultMessage);
});

app.command('/summarize', async ({ command, ack, say }) => {
    await ack();
    stats.summariesGenerated++;
    await saveStats();
    const sourceName = command.text.trim().toLowerCase();
    let content;

    switch(sourceName) {
        case 'google_doc': content = await KnowledgeSource.getGoogleDocContent(GOOGLE_DOC_ID); break;
        case 'notion': content = await KnowledgeSource.getNotionPageContent(NOTION_PAGE_ID); break;
        case 'url': content = await KnowledgeSource.getURLContent(KNOWLEDGE_URL); break;
        default: await say("Please specify a source: `google_doc`, `notion`, or `url`."); return;
    }

    if (!content) {
        await say(`I couldn't find any content for \`${sourceName}\`.`);
        return;
    }

    const thinkingMessage = await say(`Summarizing \`${sourceName}\`...`);
    const prompt = `Provide a concise, professional, bullet-point summary of the following document:\n\n${content}`;
    const summary = await AIService.generateAnswer(prompt);
    
    await app.client.chat.update({
        channel: command.channel_id,
        ts: thinkingMessage.ts,
        text: `Summary of ${sourceName}`,
        blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*Summary of ${sourceName}*` } },
            { type: "divider" },
            { type: "section", text: { type: "mrkdwn", text: summary } }
        ]
    });
});

app.command('/digest', async ({ command, ack, say }) => {
    await ack();
    stats.digestsGenerated++;
    await saveStats();
    
    if (indexedKnowledge.startsWith("No knowledge")) {
        await say("I can't create a digest because no knowledge has been indexed yet. Please run `/index` first.");
        return;
    }

    const thinkingMessage = await say(`🔬 Analyzing the entire knowledge base to create a digest...`);
    const prompt = `You are an expert analyst. Create a high-level executive summary (a "digest") of the entire knowledge base provided below. Identify the 3-5 most important themes, projects, or topics. Present them as clear, concise bullet points.

KNOWLEDGE BASE:
---
${indexedKnowledge}
---
`;
    const digest = await AIService.generateAnswer(prompt);
    
    await app.client.chat.update({
        channel: command.channel_id,
        ts: thinkingMessage.ts,
        text: `Knowledge Base Digest`,
        blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*Knowledge Base Digest*` } },
            { type: "divider" },
            { type: "section", text: { type: "mrkdwn", text: digest } }
        ]
    });
});

app.command('/ask-direct', async ({ command, ack, say }) => {
    await ack();
    stats.directAsks++;
    await saveStats();
    const question = command.text.trim();
    if (!question) {
        await say("Please provide a question to ask the AI directly.");
        return;
    }
    const thinkingMessage = await say(`🤔 Asking the AI directly...`);
    const prompt = `You are ${currentPersona}. Answer the following question directly: ${question}`;
    const answer = await AIService.generateAnswer(prompt);
    await app.client.chat.update({ channel: command.channel_id, ts: thinkingMessage.ts, text: answer });
});

app.command('/ask-image', async ({ command, ack, say }) => {
    await ack();
    const commandText = command.text.trim();
    const urlMatch = commandText.match(/^(https?:\/\/[^\s]+)/);
    if (!urlMatch) {
        await say("Please provide a valid URL first, followed by your question. e.g., `/ask-image <url> what is this?`");
        return;
    }
    const imageUrl = urlMatch[0];
    const question = commandText.substring(imageUrl.length).trim();
    if (!question) {
        await say("Please provide a question to ask about the image.");
        return;
    }
    const thinkingMessage = await say(`🖼️ Analyzing the image and thinking about your question...`);
    const answer = await AIService.generateAnswerFromImage(question, imageUrl);
    await app.client.chat.update({ channel: command.channel_id, ts: thinkingMessage.ts, text: answer });
});

app.command('/set-persona', async ({ command, ack, say }) => {
    await ack();
    const newPersona = command.text.trim();
    if (!newPersona) {
        await say("Please provide a persona. For example: `/set-persona a witty pirate`");
        return;
    }
    currentPersona = newPersona;
    stats.personasSet++;
    await saveStats();
    await say(`Aye aye, captain! My persona is now: *${currentPersona}*`);
});

app.command('/configure', async ({ ack, client, command }) => {
    await ack();
    const view = {
        type: 'modal',
        title: {
            type: 'plain_text',
            text: 'Bot Configuration'
        },
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: 'Here are the current settings for the knowledge sources:'
                }
            },
            { type: 'divider' },
            {
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `*Google Doc ID:*\n\`${GOOGLE_DOC_ID || 'Not Set'}\`` },
                    { type: 'mrkdwn', text: `*Notion Page ID:*\n\`${NOTION_PAGE_ID || 'Not Set'}\`` },
                    { type: 'mrkdwn', text: `*Knowledge URL:*\n\`${KNOWLEDGE_URL || 'Not Set'}\`` },
                    { type: 'mrkdwn', text: `*Feedback Channel:*\n${FEEDBACK_CHANNEL_ID ? `<#${FEEDBACK_CHANNEL_ID}>` : 'Not Set'}` }
                ]
            }
        ]
    };
    await client.views.open({
        trigger_id: command.trigger_id,
        view: view
    });
});

app.command('/stats', async ({ command, ack, say }) => {
    await ack();
    const uptime = Math.floor((new Date() - new Date(stats.startTime)) / 1000 / 60);
    const statsText = `
*Bot Analytics*
> *Uptime (since last start):* ${uptime} minutes
> *Total Questions Asked:* ${stats.questionsAsked}
> *Image Questions:* ${stats.imageAsks}
> *Direct AI Asks:* ${stats.directAsks}
> *Summaries Generated:* ${stats.summariesGenerated}
> *Digests Generated:* ${stats.digestsGenerated}
> *Personas Set:* ${stats.personasSet}
> *AI Fallbacks Used:* ${stats.fallbacksUsed}
> *Feedback Received:* ${stats.feedbackReceived}
    `.trim().replace(/^\s+/gm, '');
    await say({ text: "Bot Stats", blocks: [{ type: "section", text: { type: "mrkdwn", text: statsText } }] });
});

app.command('/help', async ({ command, ack, say }) => {
    await ack();
    const helpText = `
*❓ How to Ask Questions*
• Simply @mention me with your question.
• To focus on a specific source, add \`from [source]\` (e.g., \`@KnowledgeBot what is project titan from google_doc\`).

*🤖 Available Commands*
• \`/index\`: Re-indexes all knowledge sources.
• \`/summarize [source]\`: Summarizes \`google_doc\`, \`notion\`, or \`url\`.
• \`/digest\`: Creates a high-level summary of the entire knowledge base.
• \`/ask-direct [question]\`: Ask the AI a question directly.
• \`/ask-image [url] [question]\`: Asks a question about an image.
• \`/set-persona [description]\`: Changes my personality.
• \`/configure\`: Shows the current configuration.
• \`/stats\`: Shows bot usage analytics.
• \`/help\`: Shows this help message.

*👍 Provide Feedback*
• React to any of my answers with a :+1: or :-1: emoji.
• Use the "Explain This" message action on any message to get more context.
    `.trim().replace(/^\s+/gm, '');
    await say({ text: "Help Information", blocks: [{ type: 'section', text: { type: "mrkdwn", text: helpText } }] });
});

app.event('app_mention', async ({ event, client }) => {
    const userQuestion = event.text.replace(/<@.*?>/g, '').trim();
    if (!userQuestion) return;

    const sourceRegex = /\sfrom\s(google_doc|notion|url)$/i;
    const match = userQuestion.match(sourceRegex);
    let documentOverride = null;

    if (match) {
        const sourceName = match[1].toLowerCase();
        const cleanQuestion = userQuestion.replace(sourceRegex, '').trim();
        let content;
        switch(sourceName) {
            case 'google_doc': content = await KnowledgeSource.getGoogleDocContent(GOOGLE_DOC_ID); break;
            case 'notion': content = await KnowledgeSource.getNotionPageContent(NOTION_PAGE_ID); break;
            case 'url': content = await KnowledgeSource.getURLContent(KNOWLEDGE_URL); break;
        }
        if (!content) {
            await client.chat.postMessage({ channel: event.channel, text: `I couldn't find content for \`${sourceName}\`.` });
            return;
        }
        documentOverride = content;
        await handleQuestion(cleanQuestion, event.channel, event.user, documentOverride);
    } else {
        await handleQuestion(userQuestion, event.channel, event.user);
    }
});

// New: Handler for the "Explain This" message shortcut
app.shortcut('explain_this', async ({ shortcut, ack, client }) => {
    await ack();
    const userQuestion = shortcut.message.text;
    const channelId = shortcut.channel.id;
    const userId = shortcut.user.id;
    const threadTs = shortcut.message.ts; // Start a thread on the original message

    try {
        stats.questionsAsked++;
        await saveStats();
        const thinkingMessage = await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `🤔 Let me explain that...` });

        const prompt = `You are ${currentPersona}. The user wants an explanation or more context about the following message. Use the DOCUMENT to provide a relevant answer.\n\nMESSAGE TO EXPLAIN:\n"${userQuestion}"\n\nDOCUMENT:\n${indexedKnowledge}`;
        
        const mainAnswer = await AIService.generateAnswer(prompt);
        
        await client.chat.update({
            channel: channelId,
            ts: thinkingMessage.ts,
            text: mainAnswer
        });

    } catch (error) {
        console.error("❌ Error in 'Explain This' shortcut:", error);
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "I'm sorry, I encountered an error trying to explain that." });
    }
});

app.event('reaction_added', async ({ event, client }) => {
    if (event.reaction !== '+1' && event.reaction !== '-1') return;
    try {
        const botInfo = await client.auth.test();
        if (event.item.type === 'message' && event.item_user === botInfo.user_id) {
            stats.feedbackReceived++;
            await saveStats();
            const permalink = await client.chat.getPermalink({ channel: event.item.channel, message_ts: event.item.ts });
            const feedbackText = `*Feedback Received!* :${event.reaction}: from <@${event.user}> on <${permalink.permalink}|this message>.`;
            console.log(`📝 Feedback: ${event.reaction} from ${event.user}`);
            if (FEEDBACK_CHANNEL_ID) {
                await client.chat.postMessage({ channel: FEEDBACK_CHANNEL_ID, text: feedbackText });
            }
        }
    } catch (error) {
        console.error("❌ Error processing reaction:", error);
    }
});

// -----------------------------------------------------------------------------
// APPLICATION STARTUP
// -----------------------------------------------------------------------------

(async () => {
    try {
        await loadStats();
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
