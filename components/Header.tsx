import Logo from './Logo';

export default function Header() {
  return (
    <div className="text-center mb-8">
      <Logo />
      <h1 className="text-4xl font-bold text-gray-900 mb-2">Current Wet Bulb Temperature</h1>
      <p className="text-gray-600">Get real-time wet bulb temperature for any location</p>
    </div>
  );
}
