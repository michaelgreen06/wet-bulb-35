import { GetStaticProps, GetStaticPaths } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import fs from 'fs';
import path from 'path';
import { toSlug } from '../../../../lib/utils/string';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import { useRouter } from 'next/router';

interface CityData {
  name: string;
  latitude: number;
  longitude: number;
}

interface StatePageProps {
  countryName: string;
  stateName: string;
  cities: CityData[];
}

export default function StatePage({ countryName, stateName, cities }: StatePageProps) {
  const router = useRouter();
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.wetbulb35.com';
  
  // Show loading state while page is being generated
  if (router.isFallback) {
    return <div>Loading...</div>;
  }
  
  const countrySlug = toSlug(countryName);
  const stateSlug = toSlug(stateName);
  const pageTitle = `Wet Bulb Temperature in ${stateName}, ${countryName}`;
  const pageDescription = `Browse wet bulb temperature data for cities in ${stateName}, ${countryName}. Select a city to view detailed weather data.`;
  const canonicalUrl = `${baseUrl}/wetbulb-temperature/${countrySlug}/${stateSlug}`;
  const imageUrl = `${baseUrl}/images/wetbulb-default.jpg`;

  // Breadcrumb structured data
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": "Wet Bulb Temperature",
        "item": `${baseUrl}/wetbulb-temperature`
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": countryName,
        "item": `${baseUrl}/wetbulb-temperature/${countrySlug}`
      },
      {
        "@type": "ListItem",
        "position": 3,
        "name": stateName,
        "item": `${baseUrl}/wetbulb-temperature/${countrySlug}/${stateSlug}`
      }
    ]
  };



  return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="description" content={pageDescription} />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="robots" content="index, follow" />
        <link rel="canonical" href={canonicalUrl} />
        
        {/* Open Graph tags */}
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
            __html: JSON.stringify(breadcrumbData)
          }}
        />
      </Head>

      <div className="max-w-4xl mx-auto space-y-8">
        <Header />
        
        <div className="space-y-6">
          <div className="mt-6">
            <div className="mb-6">
              <Link href={`/wetbulb-temperature/${countrySlug}`} className="text-blue-600 hover:underline">
                ← Back to {countryName}
              </Link>
            </div>
            
            <h1 className="text-3xl font-bold mb-6">Cities in {stateName}, {countryName}</h1>
            
            {cities.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {cities.map((city) => (
                  <Link 
                    key={city.name} 
                    href={`/wetbulb-temperature/${countrySlug}/${stateSlug}/${toSlug(city.name)}`}
                    className="p-4 border rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <div className="font-semibold">{city.name}</div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="p-4 border rounded-lg bg-gray-50">
                <p>No cities found for this state/province.</p>
              </div>
            )}
          </div>
        </div>
      </div>
      
      <Footer />
    </>
  );
}

export const getStaticPaths: GetStaticPaths = async () => {
  // We'll generate these paths on demand using fallback: true
  return {
    paths: [],
    fallback: true
  };
};

export const getStaticProps: GetStaticProps = async ({ params }) => {
  try {
    if (!params?.country || !params?.state) {
      return { notFound: true };
    }

    const countrySlug = params.country as string;
    const stateSlug = params.state as string;
    
    // Read and parse the cities data
    const citiesPath = path.join(process.cwd(), 'scripts', 'resolved_cities.json');
    
    if (!fs.existsSync(citiesPath)) {
      console.error('Cities data file not found:', citiesPath);
      return { notFound: true };
    }

    const citiesData = JSON.parse(fs.readFileSync(citiesPath, 'utf-8'));
    
    // Find the country and state by slug
    let countryName = '';
    let stateName = '';
    
    // First find the country
    const countryMatch = citiesData.find((city: any) => {
      const match = toSlug(city.resolvedCountryName) === countrySlug;
      if (match) {
        countryName = city.resolvedCountryName;
      }
      return match;
    });
    
    if (!countryName) {
      console.log('No matching country found for slug:', countrySlug);
      return { notFound: true };
    }
    
    // Then find the state within that country
    const stateMatch = citiesData.find((city: any) => {
      const matchCountry = city.resolvedCountryName === countryName;
      const matchState = toSlug(city.resolvedAdmin1Code) === stateSlug;
      if (matchCountry && matchState) {
        stateName = city.resolvedAdmin1Code;
      }
      return matchCountry && matchState;
    });
    
    if (!stateName) {
      console.log('No matching state found for slug:', stateSlug);
      return { notFound: true };
    }
    
    // Get all cities in this state and country
    const cities = citiesData
      .filter((city: any) => 
        city.resolvedCountryName === countryName && 
        city.resolvedAdmin1Code === stateName
      )
      .map((city: any) => ({
        name: city.name,
        latitude: city.latitude,
        longitude: city.longitude
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    return {
      props: {
        countryName,
        stateName,
        cities
      },
      revalidate: 86400 // Revalidate once per day
    };
  } catch (error) {
    console.error('Error in getStaticProps:', error);
    return { notFound: true };
  }
};
