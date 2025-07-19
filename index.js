const { App } = require("@slack/bolt");


const app = new App({

  token: "",
  signingSecret: "",
});

(async () => {
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
})();