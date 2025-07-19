const { App } = require("@slack/bolt");


const app = new App({

  token: "xoxb-9246010537840-9246024678096-4twLgQN8f3sjJSSHWvOv75dT",
  signingSecret: "e712eca3bed82bec62d67e780a7ffba1",
});

(async () => {
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
})();