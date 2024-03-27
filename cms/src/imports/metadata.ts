import dotenv from "dotenv";
import path from "path";
import csv from "csvtojson";
import payload from "payload";
import { Metadata } from "../payload-types";
import buildConfig from "../payload.config";

dotenv.config();
payload.init({
  config: buildConfig,
  secret: process.env.PAYLOAD_SECRET,
  local: true,
  onInit: async () => {
    const metadataSource: { [key: string]: Metadata } = {};
    const csvPath = path.resolve(
      __dirname,
      "../../../analysis/data/asx_company_metadata_with_images.csv"
    );
    csv()
      .fromFile(csvPath)
      .then(async (fromCSV) => {
        fromCSV.forEach((source: Metadata) => {
          metadataSource[source.stock_code] = source;
        });
        // eslint-disable-next-line no-restricted-syntax
        for (const key of Object.keys(metadataSource)) {
          const source = metadataSource[key];

          const data: Omit<Metadata, "id" | "createdAt" | "updatedAt"> = {
            stock_code: source.stock_code,
            company_name: source.company_name,
            details: source.details,
            summary: source.summary,
            address: source.address,
            website: source.website,
            links: source.links,
            images: source.images,
            company_logo_link: source.company_logo_link,
            // other fields you might have
          };
          try {
            // eslint-disable-next-line no-await-in-loop
            await payload.create({
              collection: "metadata",
              overrideAccess: true,
              locale: "en",
              showHiddenFields: false,
              // If creating verification-enabled auth doc,
              // you can optionally disable the email that is auto-sent
              disableVerificationEmail: true,

              data,
            });
            console.log("created: ", data.stock_code);
          } catch (e) {
            console.log(payload.config.collections);
            console.log(data);
            console.log(e);
            // eslint-disable-next-line no-continue
            console.log("skip: ", data.stock_code);
            // eslint-disable-next-line no-continue
            continue;
          }
          console.log("DONE");
        }
      })
      .then(() => process.exit(0));
  },
});
