export type Point = [number, number];
export type Ring = Point[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

export interface ImageMeta {
  id: string;
  sha256: string;
  filename: string;
  stored: string;
  width: number;
  height: number;
  format: string;
  size: number;
}

export interface Annotation {
  object_id: string;
  category: string;
  geometry: MultiPolygon;
  updated_at?: string;
}

export type DraftMap = Record<string, Annotation[]>;

export interface VersionMeta {
  version: number;
  submitted_at: string;
  note: string;
  digest: string;
  image_count: number;
  annotation_count: number;
}

export interface AppState {
  project: { images: ImageMeta[]; categories: string[] };
  draft: { annotations: DraftMap; updated_at: string };
  versions: VersionMeta[];
}
