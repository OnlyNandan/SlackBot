require('dotenv').config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

async function getGoogleDocContent(documentId) {
  try {
    let auth;
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      console.log("Authenticating with Google using JSON credentials from environment variable...");
      const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/documents.readonly'],
      });
    } else {
      console.log("Authenticating with Google using key file from GOOGLE_APPLICATION_CREDENTIALS...");
      auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/documents.readonly'],
      });
    }

    const authClient = await auth.getClient();
    const docs = google.docs({ version: 'v1', auth: authClient });

    console.log(`Fetching content from Google Doc ID: ${documentId}`);
    const res = await docs.documents.get({ documentId });

    let text = '';
    res.data.body.content.forEach(element => {
      if (element.paragraph) {
        element.paragraph.elements.forEach(elem => {
          if (elem.textRun) {
            text += elem.textRun.content;
          }
        });
      }
    });
    console.log("Successfully fetched document content.");
    return text;
  } catch (error) {
    console.error("❌ Error fetching from Google Docs:", error.message);
    return "Error: Could not retrieve the knowledge base document.";
  }
}

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
receiver.router.get('/', (req, res) => {
  res.status(200).send('I am alive and ready to serve!');
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});

app.event('app_mention', async ({ event, client, say }) => {
  console.log("✅ app_mention event received!");
  const userQuestion = event.text.replace(/<@.*?>/g, '').trim();

  try {
    // THIS IS THE ONLY LINE THAT CHANGED
    const documentId = process.env.GOOGLE_DOC_ID; 
    const contextDocument = await getGoogleDocContent(documentId);

    if (contextDocument.startsWith("Error:")) {
      await say(contextDocument);
      return;
    }

    const prompt = `
      You are a helpful assistant. Answer the following question based *only* on the provided document.
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

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Bolt app is running on port ${port}!`);
})();