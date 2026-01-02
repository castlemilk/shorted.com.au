import { Endpoint } from "payload/config";
import { clearDB } from "./reset";

export const clearDBEndpoint: Omit<Endpoint, "root"> = {
  handler: async (req, res) => {
    //   const key = req.query?.key

    //   if (key === undefined) {
    //     return res.status(400).json({ error: 'Missing key query param.' })
    //   }

    //   if (key !== process.env.PAYLOAD_DEMO_RESET_KEY) {
    // return res.status(400).json({ error: 'Incorrect clearDB key.' })
    //   }

    await clearDB();

    return res
      .status(200)
      .json({ message: "Successfully cleared the DB from endpoint." });
  },
  method: "get",
  path: "/clear-db",
};
