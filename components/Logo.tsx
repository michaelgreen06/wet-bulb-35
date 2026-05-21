import Image from 'next/image';
import Link from 'next/link';

export default function Logo() {
  return (
    <div className="flex justify-center mb-4">
      <Link href="/" className="cursor-pointer">
        <Image
          src="/logo.svg"
          alt="Wet Bulb Temperature Logo"
          width={80}
          height={80}
          priority
        />
      </Link>
    </div>
  );
}
