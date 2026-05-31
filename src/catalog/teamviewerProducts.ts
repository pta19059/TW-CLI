import { ProductKey } from "../types.js";

export interface ProductDefinition {
  key: ProductKey;
  name: string;
  category: "remote-access" | "enterprise" | "ar" | "it-ops" | "digital-workplace";
  aliases: string[];
}

// Verified with publicly available TeamViewer product naming as of 2026-05-28.
// If TeamViewer updates naming/packaging, update this list before release.
export const TEAMVIEWER_PRODUCTS: ProductDefinition[] = [
  {
    key: "teamviewer-remote",
    name: "TeamViewer Remote",
    category: "remote-access",
    aliases: ["remote", "teamviewer remote"]
  },
  {
    key: "teamviewer-tensor",
    name: "TeamViewer Tensor",
    category: "enterprise",
    aliases: ["tensor", "teamviewer tensor"]
  },
  {
    key: "teamviewer-frontline",
    name: "TeamViewer Frontline",
    category: "ar",
    aliases: ["frontline", "teamviewer frontline"]
  },
  {
    key: "teamviewer-assist-ar",
    name: "TeamViewer Assist AR",
    category: "ar",
    aliases: ["assist ar", "teamviewer assist ar"]
  },
  {
    key: "teamviewer-remote-management",
    name: "TeamViewer Remote Management",
    category: "it-ops",
    aliases: ["remote management", "monitoring", "rmm"]
  },
  {
    key: "teamviewer-dex",
    name: "TeamViewer DEX",
    category: "digital-workplace",
    aliases: ["dex", "teamviewer dex"]
  }
];

export function normalizeProduct(input: string): ProductKey | null {
  const normalized = input.trim().toLowerCase();

  for (const product of TEAMVIEWER_PRODUCTS) {
    if (product.key === normalized || product.aliases.includes(normalized)) {
      return product.key;
    }
  }

  return null;
}

export function productName(key: ProductKey): string {
  return TEAMVIEWER_PRODUCTS.find((p) => p.key === key)?.name ?? key;
}
