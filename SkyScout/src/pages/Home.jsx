import HeroSection from "../components/hero/HeroSection";
import Navbar from "../components/layout/Navbar";
import FlightSearchCard from "../components/search/FlightSearchCard";

function Home() {
  return (
    <>
      <Navbar />
      <main>
        <HeroSection />
        <FlightSearchCard />
      </main>
    </>
  );
}

export default Home;
