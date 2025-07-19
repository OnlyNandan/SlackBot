require('dotenv').config();

const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

app.event('app_mention', async ({ event, say }) => {
  try {
    await say(`Hello there, <@${event.user}>!`);
  }
  catch (error) {
    console.error("Error sending reply:", error);
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Bolt app is running on port ${port}!`);
})();