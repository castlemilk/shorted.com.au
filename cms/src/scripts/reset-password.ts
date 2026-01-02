import payload from "payload";
import buildConfig from "../payload.config";
payload.init({
  config: buildConfig,
  secret: process.env.PAYLOAD_SECRET,
  local: true,
  onInit: async () => {
    const token = await payload.forgotPassword({
      collection: "users",
      data: {
        email: "test@lol.com",
      },
      disableEmail: true, // you can disable the auto-generation of email via local API
    });
    console.log(token);
  },
});
