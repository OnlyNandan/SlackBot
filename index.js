require('dotenv').config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const { Client } = require("@notionhq/client");

// =================================================================
// NEW: Function to read from Confluence
// =================================================================
async function getConfluencePageContent(pageId) {
  const baseUrl = process.env.CONFLUENCE_URL;
  const email = process.env.CONFLUENCE_USER_EMAIL;
  const apiToken = process.env.CONfluence_API_TOKEN;

  // We need to create a base64-encoded token for Basic Authentication
  const authToken = Buffer.from(`${email}:${apiToken}`).toString('base64');
  
  // The API endpoint to get a page and expand it to include the content
  const apiUrl = `${baseUrl}/wiki/rest/api/content/${pageId}?expand=body.storage`;

  try {
    console.log(`Fetching content from Confluence Page ID: ${pageId}`);
    const response = await fetch(apiUrl, {
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    // The content is in HTML format, so we'll do a simple cleanup to get text
    const rawHtml = data.body.storage.value;
    const text = rawHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    console.log("Successfully fetched Confluence content.");
    return text;
  } catch (error) {
    console.error("❌ Error fetching from Confluence:", error.message);
    return "Error: Could not retrieve the Confluence document.";
  }
}
// =================================================================


// --- Your existing Notion and Google Docs functions remain here ---
async function getNotionPageContent(pageId) { /* ... no changes ... */ }
async function getGoogleDocContent(documentId) { /* ... no changes ... */ }


// --- App Initialization (no changes) ---
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
receiver.router.get('/', (req, res) => { res.status(200).send('I am alive and ready to serve!'); });
const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver: receiver });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});


// --- Listen for mentions (Temporarily modified for Confluence testing) ---
app.event('app_mention', async ({ event, client, say }) => {
  console.log("✅ app_mention event received!");
  const userQuestion = event.text.replace(/<@.*?>/g, '').trim();

  try {
    // FOR TESTING: We are now calling the Confluence function.
    const confluencePageId = "131262"; 
    const contextDocument = await getConfluencePageContent(confluencePageId);

    if (contextDocument.startsWith("Error:")) {
      await say(contextDocument);
      return;
    }

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