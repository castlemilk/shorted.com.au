/**
 * schema from:
 * company_name,address,summary,details,website,stock_code,links,images,company_logo_link
1414 DEGREES LIMITED,"136 Daws Road, MELROSE PARK, SA, AUSTRALIA, 5039","Commercialising energy storage technology, thermal energy storage system providing a low cost solution to intermittent energy supply and recovering electricity through a turbine on demand.","Commercialising energy storage technology, thermal energy storage system providing a low cost solution to intermittent energy supply and recovering electricity through a turbine on demand.",http://www.1414degrees.com.au,14D,"['http://www.facebook.com/1414Degrees/', 'https://twitter.com/1414_degrees', 'https://1414degrees.com.au/', 'https://1414degrees.com.au/sibox/', '#', 'https://1414degrees.com.au/sibox/', 'https://1414degrees.com.au/auroraenergyproject/', '', 'https://1414degrees.com.au/the-team/', 'https://1414degrees.com.au/careers/', 'https://1414degrees.com.au/investors/', 'https://1414degrees.com.au/investors/', 'https://1414degrees.com.au/news/', 'https://1414degrees.com.au/the-team/', 'https://1414degrees.com.au/aurora-energy-precinct-transmission-access-update/', 'https://1414degrees.com.au/aurora-energy-precinct-transmission-access-update/', 'https://1414degrees.com.au/category/news/', 'https://1414degrees.com.au/investment-bank-updates-coverage-of-1414-degrees/', 'https://1414degrees.com.au/investment-bank-updates-coverage-of-1414-degrees/', 'https://1414degrees.com.au/category/news/', 'https://1414degrees.com.au/sibox-testing-complete-and-commercial-moves-underway/', 'https://1414degrees.com.au/sibox-testing-complete-and-commercial-moves-underway/', 'https://1414degrees.com.au/category/news/', 'https://1414degrees.com.au/page/2/', 'mailto:info@1414degrees.com.au', 'tel://+610883578273', 'https://1414degrees.com.au/investors/', 'https://1414degrees.com.au/home-new/', 'https://1414degrees.com.au/sibox/', 'https://1414degrees.com.au/the-team/', 'https://1414degrees.com.au/sibox/', 'https://1414degrees.com.au/auroraenergyproject/', 'https://1414degrees.com.au/investors/', 'https://1414degrees.com.au/privacy-policy/']","https://1414degrees.com.au/wp-content/uploads/2023/05/RGB-Logo-with-Tagline.png, https://1414degrees.com.au/wp-content/uploads/2023/05/PITSTOP_1414_DEGREES_0190_PRINT_RES_-scaled.jpg, https://1414degrees.com.au/wp-content/uploads/2023/01/Picture-2-e1677475841802.png, https://1414degrees.com.au/wp-content/uploads/2023/03/Benefits-of-SiBox-e1678254746922.png, https://1414degrees.com.au/wp-content/uploads/2023/05/long-duration-energy-storage-council-ldes.jpg-2.jpg, https://1414degrees.com.au/wp-content/uploads/2023/05/Woodside_POABF_POS_RGB.png, https://1414degrees.com.au/wp-content/uploads/2023/05/HILT_CRC_Logo_OG.png, https://1414degrees.com.au/wp-content/uploads/2023/05/australian-government-stacked-black_168791ec-96ad-3bcc-817b-27e71beb4522.png, https://1414degrees.com.au/wp-content/uploads/2024/04/aurora-400x250.jpeg, https://1414degrees.com.au/wp-content/uploads/2024/04/Screenshot-2024-04-08-at-10.22.28-am79-copy-400x250.png, https://1414degrees.com.au/wp-content/uploads/2024/03/mahesh-sibox-400x250.jpg, https://1414degrees.com.au/wp-content/uploads/2023/04/1414degrees-GreyRed-RGB.png, https://www.facebook.com/tr, https://dc.ads.linkedin.com/collect/",https://1414degrees.com.au/wp-content/uploads/2023/05/RGB-Logo-with-Tagline.png
 */
export interface Metadata {
  id: string;
  stock_code: string;
  company_name: string;
  address: string;
  summary: string;
  details: string;
  website: string;
  links: string[];
  images: string[];
  company_logo_link: string;
  createdAt: Date;
  updatedAt: Date;
}
