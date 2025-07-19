require('dotenv').config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
// NEW: Import the Notion Client
const { Client } = require("@notionhq/client");

// =================================================================
// NEW: Function to read from Notion
// =================================================================
async function getNotionPageContent(pageId) {
  // Initialize Notion client
  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  try {
    console.log(`Fetching content from Notion Page ID: ${pageId}`);
    // Get all the blocks (paragraphs, headings, etc.) from the page
    const response = await notion.blocks.children.list({
      block_id: pageId,
    });

    // Extract the plain text from each block
    let text = '';
    for (const block of response.results) {
      if (block.type && block[block.type].rich_text) {
        text += block[block.type].rich_text.map(rt => rt.plain_text).join('');
        text += '\n'; // Add a newline after each block
      }
    }
    console.log("Successfully fetched Notion content.");
    return text;
  } catch (error) {
    console.error("❌ Error fetching from Notion:", error.message);
    return "Error: Could not retrieve the Notion document.";
  }
}
// =================================================================


// --- This is your existing Google Docs function. We are leaving it here for later. ---
async function getGoogleDocContent(documentId) { /* ... no changes needed here ... */ }


// --- App Initialization (no changes) ---
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
receiver.router.get('/', (req, res) => { res.status(200).send('I am alive and ready to serve!'); });
const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver: receiver });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});


// --- Listen for mentions (Temporarily modified for Notion testing) ---
app.event('app_mention', async ({ event, client, say }) => {
  console.log("✅ app_mention event received!");
  const userQuestion = event.text.replace(/<@.*?>/g, '').trim();

  try {
    // FOR TESTING: We are calling the Notion function instead of the Google Docs one.
    const notionPageId = "2355be80190b803f8457e77a737af98f";
    const contextDocument = await getNotionPageContent(notionPageId);

    if (contextDocument.startsWith("Error:")) {
      await say(contextDocument);
      return;
    }

    // The rest of the AI prompt logic is the same
    const prompt = `
      You are a helpful assistant. Answer the question based *only* on the provided document.
      If the answer is not found in the document, say "I do not have information on that."

      DOCUMENT:
      ---
      ${contextDocument}
      ---
      QUESTION: "${userQuestion}"
    `;

    console.log("🤖 Sending prompt to AI...");
    const result = await model.generateContent(prompt);
    const aiResponseText = result.response.text();
    console.log("🧠 AI Response:", aiResponseText);

    await say(aiResponseText);

  } catch (error) {
    console.error("❌ Error processing AI request:", error);
    await say("Sorry, I encountered an error while thinking. Please try again.");
  }
});


// --- Start the App (no changes) ---
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Bolt app is running on port ${port}!`);
})();