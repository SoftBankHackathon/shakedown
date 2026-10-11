import Image from "next/image";
import { BsBuilding, BsCloud, BsHddNetwork } from "react-icons/bs";

// Brand marks for the clouds live in public/providers (official-style SVGs supplied by the team).
const BRAND: Record<string, { src: string; alt: string }> = {
  aws: { src: "/providers/aws.svg", alt: "AWS" },
  gcp: { src: "/providers/gcp.svg", alt: "Google Cloud" },
  azure: { src: "/providers/azure.svg", alt: "Microsoft Azure" },
};

/** Mark per deploy target: cloud brand SVGs, Bootstrap Icons for local and on-prem. */
export function ProviderIcon({ id, size = 25 }: { id: string; size?: number }) {
  const brand = BRAND[id];
  if (brand) return <Image src={brand.src} alt={brand.alt} width={size} height={size} className={`provider ${id}`} />;
  if (id === "local") return <BsHddNetwork className="provider local" size={size} />;
  if (id === "onprem") return <BsBuilding className="provider onprem" size={size - 3} />;
  return <BsCloud className="provider" size={size} />;
}
