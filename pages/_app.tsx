import type { AppProps } from 'next/app';
import GoogleAnalytics from '../components/GoogleAnalytics';
import SharedLayout from '../components/layouts/SharedLayout';

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <GoogleAnalytics />
      <SharedLayout>
        <Component {...pageProps} />
      </SharedLayout>
    </>
  );
}
