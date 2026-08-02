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

## Inhabited Hotspots Preview

This repo includes two separate weather workflows:

- Current single-location weather uses OpenWeather through `/api/weather`.
- Inhabited hotspot forecasts use Open-Meteo through `/api/inhabited-hotspots`.

The inhabited hotspot page reads a validated `schemaVersion: 1` snapshot for the next 24 hours. The generation job runs a global grid gate, selects up to 1,000 grid-prioritized populated places above 25,000 people, scans those city coordinates exactly, and writes the top 50 places where forecast air temperature or wet-bulb thresholds are crossed.

- Page: `/inhabited-hotspots/`
- Snapshot API: `/api/inhabited-hotspots`
- Bundled fallback snapshot: `public/data/hotspots/inhabited-latest.json`
- Blob pathname: `inhabited/v1/latest.json`

Visitors cannot trigger a new forecast scan. The API reads `INHABITED_HOTSPOT_DATA_URL` first and falls back to the bundled snapshot when Blob data is unavailable or invalid.

Generate or refresh the snapshot with:

```bash
npm run generate-inhabited-hotspots
```

Publish the validated snapshot to Vercel Blob with:

```bash
npm run publish-inhabited-hotspots
```

The generation job batches 75 locations per HTTP request and keeps the existing throttling, retry, and checkpoint behavior. If Open-Meteo returns 429s, the job logs the response body and retry header, uses adaptive recovery waits, and eventually fails instead of looping forever. Run this from GitHub Actions or another controlled update job, not from user traffic. Open-Meteo data is used with attribution; see <https://open-meteo.com/>.

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

Vercel uses `npm run vercel-build`, which writes the deployment with the Build Output API in `.vercel/output`.

To avoid regenerating every static location page for changes that cannot affect the deployed output, `vercel.json` uses:

```bash
node scripts/should-ignore-vercel-build.mjs
```

The script compares the current commit to `VERCEL_GIT_PREVIOUS_SHA`, the last successful deployment SHA provided by Vercel, and skips the build when none of the deployment inputs changed. The build still runs when static generator code, city data, Tailwind config, public assets, package files, or Vercel config changes.

Set `FORCE_VERCEL_BUILD=1` on a deployment to bypass the skip logic.
