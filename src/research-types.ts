/** Public source metadata, kept outside tool content so the UI does not need raw JSON. */
export interface ResearchSource {
	id: string;
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
	/** A source is read only when page retrieval completed, not merely found in search. */
	accessedAt?: number;
	engines?: string[];
}

export interface ResearchImage {
	id: string;
	title: string;
	/** Original image URL, distinct from its publisher page. */
	url: string;
	sourceUrl: string;
	thumbnailUrl?: string;
	/** Legacy cached thumbnail pixels retained for saved-history compatibility; not rendered. */
	previewDataUrl?: string;
	width?: number;
	height?: number;
	/** True only after image.view downloaded and decoded the image. */
	viewed?: boolean;
}

export interface ResearchResults {
	sources?: ResearchSource[];
	images?: ResearchImage[];
}
