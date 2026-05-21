import Head from "next/head";
import { useRouter } from "next/router";
import { GetStaticProps, GetStaticPaths } from "next";
import fs from "fs";
import path from "path";
import { toSlug } from "../../lib/utils/string";
import WeatherDisplay from "../../components/WeatherDisplay";
import Header from "../../components/Header";
import SearchBox from "../../components/SearchBox";
import CurrentLocationButton from "../../components/CurrentLocationButton";
import Disclaimer from "../../components/Disclaimer";
import Footer from "../../components/Footer";

interface LocationData {
  name: string;
  resolvedCountryName: string;
  resolvedAdmin1Code: string;
  latitude: number;
  longitude: number;
}

interface LocationPageProps {
  locationData: LocationData;
}

export default function LocationPage({ locationData }: LocationPageProps) {
  const router = useRouter();
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL || "https://www.wetbulb35.com";

  // Show loading state while page is being generated
  if (router.isFallback) {
    return <div>Loading...</div>;
  }

  const { name, resolvedCountryName, resolvedAdmin1Code, latitude, longitude } =
    locationData;

  // Create URL-safe versions of location parts using full names
  const citySlug = toSlug(name);
  const stateSlug = toSlug(resolvedAdmin1Code);
  const countrySlug = toSlug(resolvedCountryName);

  const pageTitle = `Wet Bulb Temperature in ${name}, ${resolvedAdmin1Code}, ${resolvedCountryName}`;
  const pageDescription = `Live wet bulb temperature and weather conditions for ${name}, ${resolvedAdmin1Code}, ${resolvedCountryName}.`;

  // Create a canonical URL with inverted structure: /country/state/city
  const canonicalUrl = `${baseUrl}/wetbulb-temperature/${countrySlug}/${stateSlug}/${citySlug}`;

  // Use a default image for social sharing
  const imageUrl = `${baseUrl}/images/wetbulb-default.jpg`;

  // Create breadcrumb structure with inverted hierarchy: country > state > city
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Wet Bulb Temperature",
        item: `${baseUrl}/wetbulb-temperature`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: resolvedCountryName,
        item: `${baseUrl}/wetbulb-temperature/${countrySlug}`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: resolvedAdmin1Code,
        item: `${baseUrl}/wetbulb-temperature/${countrySlug}/${stateSlug}`,
      },
      {
        "@type": "ListItem",
        position: 4,
        name: name,
        item: `${baseUrl}/wetbulb-temperature/${countrySlug}/${stateSlug}/${citySlug}`,
      },
    ],
  };

  const handleLocationSelect = (lat: number, lng: number) => {
    // Navigate to the home page with the selected coordinates
    router.push(`/?lat=${lat}&lng=${lng}`);
  };

  const handleCurrentLocation = () => {
    // Navigate to the home page which will use current location
    return router.push("/");
  };

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="description" content={pageDescription} />

        {/* Viewport meta tag for responsive design */}
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />

        {/* Robots meta tag */}
        <meta name="robots" content="index, follow" />

        {/* Canonical URL */}
        <link rel="canonical" href={canonicalUrl} />

        {/* Open Graph tags for social sharing */}
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={pageDescription} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonicalUrl} />
        <meta property="og:image" content={imageUrl} />
        <meta property="og:locale" content="en_US" />
        <meta property="og:site_name" content="Wet Bulb Temperature" />

        {/* Twitter Card tags */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={pageTitle} />
        <meta name="twitter:description" content={pageDescription} />
        <meta name="twitter:image" content={imageUrl} />

        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(breadcrumbData).replace(/</g, "\\u003c"),
          }}
        />
      </Head>

      <div className="max-w-4xl mx-auto space-y-8">
        <Header />

        <div className="space-y-6">
          <SearchBox onLocationSelect={handleLocationSelect} />

          <div className="mt-8">
            <CurrentLocationButton onClick={handleCurrentLocation} />
          </div>

          <WeatherDisplay
            locationName={`${name}, ${resolvedAdmin1Code}, ${resolvedCountryName}`}
            lat={latitude}
            lng={longitude}
          />

          <Disclaimer />
        </div>
      </div>

      <Footer />
    </>
  );
}
// now a static shel route
export const getStaticPaths: GetStaticPaths = async () => {
  return {
    paths: [],
    fallback: "blocking",
  };
};

export const getStaticProps: GetStaticProps = async ({ params }) => {
  try {
    if (!params?.location || !Array.isArray(params.location)) {
      return { notFound: true };
    }

    const [countrySlug, stateSlug, citySlug] = params.location;

    if (!countrySlug || !stateSlug || !citySlug) {
      return { notFound: true };
    }

    // Read and parse the cities data
    const citiesPath = path.join(
      process.cwd(),
      "scripts",
      "resolved_cities.json",
    );

    if (!fs.existsSync(citiesPath)) {
      console.error("Cities data file not found:", citiesPath);
      return { notFound: true };
    }

    const citiesData = JSON.parse(fs.readFileSync(citiesPath, "utf-8"));

    // Find the matching city with inverted parameter order (country/state/city)
    const city = citiesData.find((city: LocationData) => {
      const matchCountry =
        toSlug(city.resolvedCountryName).toLowerCase() ===
        countrySlug.toLowerCase();
      const matchState =
        toSlug(city.resolvedAdmin1Code).toLowerCase() ===
        stateSlug.toLowerCase();
      const matchCity =
        toSlug(city.name).toLowerCase() === citySlug.toLowerCase();
      return matchCountry && matchState && matchCity;
    });

    if (!city) {
      console.log("No matching city found for:", {
        countrySlug,
        stateSlug,
        citySlug,
      });
      return { notFound: true };
    }

    const locationData = {
      ...city,
    };

    return {
      props: {
        locationData,
      },
    };
  } catch (error) {
    console.error("Error in getStaticProps:", error);
    return { notFound: true };
  }
};
