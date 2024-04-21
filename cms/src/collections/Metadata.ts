import { CollectionConfig } from "payload/types";

const Metadata: CollectionConfig = {
  slug: "metadata",
  upload: {
    // TODO(bebsworth): apply fix when https://github.com/payloadcms/payload/issues/4422 is resolved
    staticURL: "https://storage.googleapis.com/shorted-company-logos",
    externalFileHeaderFilter: (headers: Record<string, string>) => {
      return {
        "content-type": headers["content-type"],
        "content-length": headers["content-length"],
      } as Record<string, string>;
    },
  },
  admin: {
    useAsTitle: "stock_code",
    defaultColumns: [
      "stock_code",
      "company_name",
      "website",
      "Company_logo_link",
      "logoImage",
    ],
    pagination: {
      defaultLimit: 50,
    },
  },
  fields: [
    {
      name: "stock_code",
      type: "text",
      required: true,
    },
    {
      name: "company_name",
      type: "text",
      required: true,
    },
    {
      name: "industry",
      type: "text",
    },
    {
      name: "market_cap",
      type: "number",
    },
    {
      name: "listing_date",
      type: "text",
    },
    {
      name: "details",
      type: "textarea",
    },
    {
      name: "summary",
      type: "textarea",
    },
    {
      name: "address",
      type: "textarea",
    },
    {
      name: "website",
      type: "text",
    },
    {
      name: "links",
      type: "array",
      fields: [
        {
          name: "link",
          type: "text",
        },
      ],
    },
    {
      name: "images",
      type: "array",
      fields: [
        {
          name: "image",
          type: "text",
        },
      ],
    },
    {
      name: "company_logo_link",
      type: "text",
    },
    {
      name: "logoImage",
      type: "upload",
      relationTo: "media",
    },
  ],
};

export default Metadata;
