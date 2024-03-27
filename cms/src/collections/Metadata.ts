import { CollectionConfig } from "payload/types";

const Metadata: CollectionConfig = {
  slug: "metadata",
  admin: {
    useAsTitle: "stock_code",
    defaultColumns: ["stock_code", "company_name", "website", "Ccmpany_logo_link"],
    pagination: {
      defaultLimit: 50,
    }
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
  ],
};

export default Metadata;
