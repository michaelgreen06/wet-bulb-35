This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Forecast Hotspots MVP

This repo includes two separate weather workflows:

- Current single-location weather uses OpenWeather through `/api/weather`.
- Forecast hotspot scans use Open-Meteo through `/api/hotspots`.

The hotspot page reads a generated global, land-focused forecast snapshot for the next 24 hours. The daily generation job fetches hourly `temperature_2m` and `relative_humidity_2m`, computes wet-bulb temperature server-side, and writes the top ranked forecast cells where air temperature or wet-bulb thresholds are crossed.

- Page: `/hotspots`
- Snapshot API: `/api/hotspots`
- Static snapshot file: `public/data/hotspots/latest.json`

Visitors cannot trigger a new forecast scan. They can only sort and filter the already-generated snapshot in the browser.

Generate or refresh the snapshot with:

```bash
npm run generate-hotspots
```

The global generation job uses a two-pass strategy: a coarse 5 degree grid first, then a 1 degree refinement around the strongest candidate cells. It batches 75 locations per HTTP request and throttles to 450 locations per minute. This is fewer than 10 HTTP requests per minute, but multi-location requests may still be weighted by server work rather than counted only as raw HTTP requests. If Open-Meteo returns 429s, the job logs the response body and retry header, uses adaptive recovery waits, and eventually fails instead of looping forever. Run this from cron or another controlled update job, not from user traffic. Open-Meteo data is used under its attribution requirements; see <https://open-meteo.com/>.

## Tests

Run the utility and scanner test suite with:

```bash
npm test
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Sitemap Generation

This project uses a static sitemap generation system that creates XML sitemap files which are committed to the repository. Since generating sitemaps for all locations is time-consuming and the location data rarely changes, this approach allows for efficient builds while ensuring search engines can discover all pages.

### Sitemap Files

The following sitemap files are included in the repository:

- `public/sitemap.xml` - The main sitemap index that references all other sitemaps
- `public/sitemaps/sitemap-main.xml` - Contains URLs for the main pages of the site
- `public/sitemaps/sitemap-categories.xml` - Contains URLs for country and state/province pages
- `public/sitemaps/sitemap-country-*.xml` - Contains URLs for city pages, one file per country

### Updating Sitemaps

If you add new locations or need to update the sitemaps for any reason, run:

```bash
npm run generate-sitemaps
```

This will create all sitemap files in the `public/sitemaps` directory. After generation, commit these files to the repository so they'll be included in the next deployment.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
