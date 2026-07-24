export type PortableUpdateManifestAsset = {
  url: string;
  sha256: string;
  sizeBytes: number;
};

export type PortableUpdateManifest = {
  schemaVersion: number;
  version: string;
  publishedAt: string;
  releaseUrl: string;
  assets: Record<string, PortableUpdateManifestAsset>;
};

export function generatePortableUpdateManifest(options: {
  directory?: string;
  output?: string;
  repository?: string;
  tag?: string;
  publishedAt?: string;
}): Promise<PortableUpdateManifest>;
