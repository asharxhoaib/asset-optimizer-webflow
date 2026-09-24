// Typed request/response models for the parts of Webflow Data API v2 this app uses.

export interface WebflowTokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
}

export interface WebflowSiteSummary {
  id: string;
  displayName?: string;
  shortName?: string;
}

export interface WebflowPagination {
  limit: number;
  offset: number;
  total: number;
}

export interface WebflowAsset {
  id: string;
  contentType?: string;
  size?: number;
  siteId?: string;
  hostedUrl?: string;
  originalFileName?: string;
  displayName?: string;
  lastUpdated?: string;
  createdOn?: string;
  altText?: string | null;
  fileHash?: string;
  width?: number;
  height?: number;
  parentFolder?: string | null;
}

export interface WebflowAssetListResponse {
  assets: WebflowAsset[];
  pagination?: WebflowPagination;
}

export interface WebflowAssetFolder {
  id: string;
  displayName: string;
  parentFolder?: string | null;
  assets?: string[];
  siteId?: string;
}

export interface WebflowAssetFolderListResponse {
  assetFolders: WebflowAssetFolder[];
  pagination?: WebflowPagination;
}

export interface WebflowAssetUpdate {
  altText?: string;
  displayName?: string;
  parentFolder?: string | null;
}

export interface WebflowAssetUploadRequest {
  fileName: string;
  fileHash: string;
  parentFolder?: string;
}

export interface WebflowAssetUploadResponse {
  id: string;
  uploadUrl: string;
  uploadDetails?: Record<string, string>;
  assetUrl?: string;
  hostedUrl?: string;
  contentType?: string;
  originalFileName?: string;
  parentFolder?: string | null;
}

export interface WebflowCollectionSummary {
  id: string;
  displayName: string;
  slug?: string;
}

export interface WebflowCollectionItem {
  id: string;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData: Record<string, unknown>;
}

export interface WebflowItemListResponse {
  items: WebflowCollectionItem[];
  pagination?: WebflowPagination;
}

export interface WebflowPageSummary {
  id: string;
  title?: string;
  slug?: string;
  archived?: boolean;
}

export interface WebflowPageListResponse {
  pages: WebflowPageSummary[];
  pagination?: WebflowPagination;
}

export interface WebflowWebhook {
  id: string;
  triggerType: string;
  url: string;
}

export interface WebflowWebhookEnvelope<T = unknown> {
  triggerType: string;
  payload: T;
}
