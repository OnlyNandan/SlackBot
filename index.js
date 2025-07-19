require('dotenv').config();
const { App } = require("@slack/bolt");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const knowledgeBase = {
  admin_document: `
    Project Phoenix Details (Admin & Leadership Only):
    - Goal: Complete redesign of the company's main product infrastructure.
    - Launch Date: Tentatively Q4 2025.
    - Budget: $5,000,000 USD.
    - Project Lead: Sarah Jenkins.
    - Key Technologies: React, Go, and a serverless architecture on AWS.
    - Codenames: The database component is codenamed "Griffin". The UI is "Firebird".
  `,
  member_document: `
    Project Phoenix Details (General Audience):
    - Goal: An exciting upcoming project to improve our main product for better performance and new features.
    - Launch Date: To be announced at the next company all-hands meeting.
    - Budget: Information not available to the public.
    - Project Lead: The project is led by our amazing engineering team.
  `
};
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});

app.receiver.router.get('/', (req, res) => {
  res.status(200).send('I am alive and ready to serve!');
});

app.event('app_mention', async ({ event, client, say }) => {
  console.log("✅ app_mention event received!");
  const userQuestion = event.text.replace(/<@.*?>/g, '').trim(); 

  try {
    const userInfo = await client.users.info({ user: event.user });
    const isAdmin = userInfo.user.is_admin;
    console.log(`User <@${event.user}> is an admin: ${isAdmin}`);

    const contextDocument = isAdmin ? knowledgeBase.admin_document : knowledgeBase.member_document;

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
    const response = await result.response;
    const aiResponseText = response.text();

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