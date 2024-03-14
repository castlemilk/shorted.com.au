# Shorted.com.au

<img src="./public/logo.png" alt="logo" width="200" />

## Overview

basic dashboarding platform for viewing short positions on ASX

## Backlog

### frontend

- [] top shorts

### backend

- [] sync short data

### misc

- [] index and build business metadata of ASX stocks



### MVP

[x] sync data to local machine
[x] basic notebook for exploring data
[x] normalise appropriately and index into blob store (S3, cloud storage)
[x] investigate options for serving time series data
[x] sync data from s3 into hot store

[ ] backend to serve hot store data
[ ] api for top 10 shorts
[ ] investigate process for fetching ABN metadata ( at least top ten)
[ ] frontend to render top 10 shorts


### Milestone 1

[ ] company metadata ingestion and real-time sentiment analysis API + view
  [ ] company index
  [ ] scraping service
  [ ] sentiment engine
  [ ] company metadata collector (financial reports, company announcements, )
[ ] commentary and/or forum support
[ ] stock data ingestion? yahoo finance? historical data?





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