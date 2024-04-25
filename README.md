# Shorted.com.au

<img src="./public/logo.png" alt="logo" width="200" />

## Overview

basic dashboarding platform for viewing short positions on ASX



### MVP

[x] sync data to local machine

[x] basic notebook for exploring data

[x] normalise appropriately and index into blob store (S3, cloud storage)

[x] investigate options for serving time series data

[x] sync data from s3 into hot store

[x] backend to serve hot store data

[x] api for top 10 shorts

[x] investigate process for fetching ABN metadata ( at least top ten)

[x] frontend to render top 10 shorts

[x] CI/CD pipeline for build and deployment to cloud run and whatever FE hosting (next?)

[x] db hosting (looking at superbase LGTM)

# week 1
[x] cron-job to pull latest shorts

[x] chart styling x,y axis

[x] more company info/metadata rendered

[x] set max to do the longest window of timeseries data possible

# week 2
[ ] company image on dark mode

[ ] query maths for top x tuned - show more sensible values for larger windows

[ ] link to google finance/yahoo finance

[ ] default logo when no image found

# week 3
[ ] company summary/description tuning

[ ] show company references

[ ] show company directors

[ ] loading & data fetch optmisations/caching

[ ] loading animations & lazy loading / suspense for concurrent fetches

# week 4
[ ] security (anon auth/ratelimiting)

[ ] fix top navbar on wide screen to float max right/left

[ ] update period title value dynamically based off selected value

[ ] time series rollup algoritm

# week 5

[ ] gamify sentiment view somehow? poo vs rocket, gague view etc

[ ] add additional items here as working...


# new items

[x] fix chart resize/shrinking on topShort view - seems to be an issue with parent div? https://github.com/airbnb/visx/issues/1014

[ ] fix media upload in payloadCMS when fix released in https://github.com/payloadcms/payload/issues/4422 or https://github.com/payloadcms/payload/issues/4421#issuecomment-1864867979 or https://github.com/payloadcms/payload/issues/5159

[ ] company image tuning - will push out to manual data entry job with payloadCMS fix above

[ ] industry/sector treemap - https://airbnb.io/visx/treemap

[ ] more mobile friendly top short view (show min/max next to current?)


## data entry pipeline

[ ] deploy playloadCMS

[ ] add valid user/login

[ ] test integration with supabase as backend

[ ] test integration with GCP as backend store

[ ] validate data entry flow ASX Code --> edit image --> add links (socials, investory page) --> get ChatGPT description and add to details

[ ] collect company socials (twitter, instagram, linkedin etc.)
### Milestone 1

[x] company metadata ingestion and real-time sentiment analysis API + view

  [x] company index

  [x] scraping service

  [ ] sentiment engine

  [ ] company metadata collector (financial reports, company announcements, )

[ ] social engagement via twitter for new short positions

[ ] automated alerts for short positions?

[ ] auth/login

[ ] commentary and/or forum support

[ ] stock data ingestion? yahoo finance? historical data?

[ ] stocks enriched with additional tags for rendering

### Milsstone 2

[ ] notification subscriptions

[ ] API as a service

[ ] news aggregation view

[ ] more advanced dynamic content collection per-stock (likely focus on top-x) gathering things like financial reports etc

[ ] further enhanced content management solution (payloadCMS) deploy & monitise somehow?

[ ] shorted bot - RAG + LLM wrapper around stocks

[ ] elastic search for stocks

[ ] user customised dashboard (my stocks, favourites etc.)

[ ] enhanced comments/forum solution




## Tech Stack

This is a T3 Stack project bootstrapped with create-t3-app.

If you are not familiar with the different technologies used in this project, please refer to the respective docs. If you still are in the wind, please join our [Discord](https://t3.gg/discord) and ask for help.

- [Next.js](https://nextjs.org)
- [NextAuth.js](https://next-auth.js.org)
- [Prisma](https://prisma.io)
- [Tailwind CSS](https://tailwindcss.com)
- [tRPC](https://trpc.io)

## Learn More

To learn more about the [T3 Stack](https://create.t3.gg/), take a look at the following resources:

- [Documentation](https://create.t3.gg/)
- [Learn the T3 Stack](https://create.t3.gg/en/faq#what-learning-resources-are-currently-available) — Check out these awesome tutorials

You can check out the [create-t3-app GitHub repository](https://github.com/t3-oss/create-t3-app) — your feedback and contributions are welcome!


### References

[1] nextjs + connect-query + connect-web - https://github.com/connectrpc/examples-es/tree/main/nextjs
[1.1] https://connectrpc.com/docs/web/ssr