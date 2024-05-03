import path from "path";

import { payloadCloud } from "@payloadcms/plugin-cloud";
import { postgresAdapter } from "@payloadcms/db-postgres";
import { webpackBundler } from "@payloadcms/bundler-webpack";
import { slateEditor } from "@payloadcms/richtext-slate";
import { buildConfig } from "payload/config";
import { cloudStorage } from "@payloadcms/plugin-cloud-storage";
import { gcsAdapter } from "@payloadcms/plugin-cloud-storage/gcs";
import Users from "./collections/Users";
import Metadata from "./collections/Metadata";
import { Media } from "./collections/Media";
import { clearDBEndpoint } from "./endpoints/cleardb";

const adapter = gcsAdapter({
  options: {
    // you can choose any method for authentication, and authorization which is being provided by `@google-cloud/storage`
    keyFilename: "./../cms/shorted-dev-aba5688f-29888585305b.json",
    //OR
    // credentials: JSON.parse(process.env.GCS_CREDENTIALS || '{}'), // this env variable will have stringify version of your credentials.json file
  },
  bucket: process.env.GCS_BUCKET || "shorted-company-logos",
  acl: "Public",

});

const m = path.resolve(__dirname, "./emptyModuleMock.js");

export default buildConfig({
  admin: {
    user: Users.slug,
    bundler: webpackBundler(),
    webpack: (config) => {
      config.resolve = {
        ...config.resolve,
        fallback: {
          fs: false,
          path: false,
          os: false,
          crypto: false,
        },
      };
      return config;
    },
    // webpack: (config) => ({
    //   ...config,
    //   resolve: {
    //     ...config.resolve,
    //     alias: {
    //       ...config.resolve?.alias,
    //       express: m,
    //       [path.resolve(__dirname, "./endpoints/")]: m,
    //     },
    //   },
    // }),
  },
  editor: slateEditor({}),
  collections: [Users, Metadata, Media],
  typescript: {
    outputFile: path.resolve(__dirname, "payload-types.ts"),
  },
  graphQL: {
    schemaOutputFile: path.resolve(__dirname, "generated-schema.graphql"),
  },

  endpoints: [clearDBEndpoint],
  plugins: [
    payloadCloud(),
    cloudStorage({
      collections: {
        // media: {
        //   adapter: adapter, // see docs for the adapter you want to use
        //   disablePayloadAccessControl: true,
        //   prefix: "media",
        //   generateFileURL: (file) => {
        //     return `https://storage.googleapis.com/${
        //       process.env.GCS_BUCKET || "shorted-company-logos"
        //     }/media/${file.filename}`;
        //   },
        // },
        metadata: {
          adapter: adapter, // see docs for the adapter you want to use
          
          disablePayloadAccessControl: true,
          prefix: "logos",
          generateFileURL: (file) => {
            return `https://storage.googleapis.com/${
              process.env.GCS_BUCKET || "shorted-company-logos"
            }/logos/${file.filename}`;
          },
        },
      },
    }),
  ],
  db: postgresAdapter({
    schemaName: "payloadcms",
    pool: {
      connectionString: process.env.DATABASE_URI,
    },
  }),
});
