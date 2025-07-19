require('dotenv').config();
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// We are adding 'client' here to access the full Slack API
app.event('app_mention', async ({ event, client, say }) => {
  console.log("✅ app_mention event received!");

  try {
    // 1. Fetch information about the user who sent the message
    const userInfo = await client.users.info({
      user: event.user
    });

    // 2. Log the user's information to the console
    // This will help us see what data we can use for roles
    console.log("User Info:", userInfo.user);

    const userRole = userInfo.user.is_admin ? "Admin" : "Member";

    // 3. Send a reply that acknowledges the user's role
    await say(`Hello <@${event.user}>! I see you are an '${userRole}'. How can I help you today?`);

  } catch (error) {
    console.error("❌ Error fetching user info or replying:", error);
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Bolt app is running on port ${port}!`);
})();