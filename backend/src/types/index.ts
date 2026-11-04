export interface Software {
  id: number;
  bundleID: string;
  name: string;
  version: string;
  price?: number;
  artistName: string;
  sellerName: string;
  description: string;
  averageUserRating: number;
  userRatingCount: number;
  artworkUrl: string;
  screenshotUrls: string[];
  minimumOsVersion: string;
  fileSizeBytes?: string;
  releaseDate: string;
  releaseNotes?: string;
  formattedPrice?: string;
  primaryGenreName: string;
}

export interface Sinf {
  id: number;
  sinf: string; // base64 encoded
}

export interface DownloadTask {
  id: string;
  software: Software;
  accountHash: string;
  /** App Store storefront country code at download time, e.g. CN/JP/US */
  region?: string;
  downloadURL: string;
  sinfs: Sinf[];
  iTunesMetadata?: string;
  status: 'pending' | 'downloading' | 'paused' | 'injecting' | 'completed' | 'failed';
  progress: number;
  speed: string;
  error?: string;
  filePath?: string;
  createdAt: string;
  /** Apple ID email of the downloading account (used for the R2 object path) */
  accountEmail?: string;
  /** Size in bytes, recorded so uploaded packages can be listed after local deletion */
  fileSize?: number;
  r2Key?: string;
  r2Status?: 'pending' | 'uploading' | 'uploaded' | 'failed';
  r2Error?: string;
}

export interface PackageInfo {
  id: string;
  software: Software;
  accountHash: string;
  filePath: string;
  fileSize: number;
  createdAt: string;
}
