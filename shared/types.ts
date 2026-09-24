// DTOs shared between the Express server and the Designer Extension App Panel.

export type AltStatus = "present" | "suggested" | "missing";
export type FindingKind = "oversized" | "legacy_format" | "missing_alt" | "duplicate" | "unused";

export interface AssetDto {
  assetId: string;
  displayName: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  hostedUrl: string;
  folderId: string | null;
  folderPath: string;
  altText: string;
  altStatus: AltStatus;
  contentHash: string | null;
  archived: number;
  refCount: number;
}

export interface FolderDto {
  folderId: string;
  name: string;
  parentId: string | null;
  path: string;
}

export interface FindingDto {
  id: number;
  assetId: string;
  displayName: string;
  kind: FindingKind;
  detail: string;
}

export interface AuditSummary {
  total: number;
  counts: Record<FindingKind, number>;
  warnings: string[];
  findings: FindingDto[];
}

export type SuggestionStatus = "pending" | "approved" | "rejected";

export interface AltSuggestionDto {
  id: number;
  assetId: string;
  displayName: string;
  hostedUrl: string;
  suggestion: string;
  provider: string;
  status: SuggestionStatus;
}

export type JobStatus = "planned" | "running" | "completed" | "skipped" | "failed";

export interface JobDto {
  id: number;
  assetId: string;
  displayName: string;
  newAssetId: string | null;
  status: JobStatus;
  originalBytes: number;
  newBytes: number | null;
  targetFormat: string;
  dryRun: number;
  note: string;
  createdAt: string;
}

export interface SettingsDto {
  maxBytes: number;
  modernFormats: string;
  targetFormat: string;
  quality: number;
  minSavingsPct: number;
  namingTemplate: string;
  folderTemplate: string;
  archiveFolderName: string;
  dryRun: boolean;
  lastAssetSync: string | null;
  lastReferenceScan: string | null;
}

export interface PlannedChange {
  assetId: string;
  before: string;
  after: string;
  applied: boolean;
  error?: string;
}

export interface SavingsRow {
  folderId: string | null;
  folderPath: string;
  jobs: number;
  originalBytes: number;
  newBytes: number;
  savedBytes: number;
}

export interface SavingsReport {
  totalJobs: number;
  originalBytes: number;
  newBytes: number;
  savedBytes: number;
  savedPct: number;
  perFolder: SavingsRow[];
}

export interface OpLogDto {
  id: number;
  kind: string;
  assetId: string;
  before: string;
  after: string;
  dryRun: number;
  createdAt: string;
}
