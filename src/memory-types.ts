/** User-visible facts, never system instructions or private model reasoning. */
export interface SavedMemory {
	id: string;
	content: string;
	projectId?: string;
	createdAt: number;
	updatedAt: number;
	revision: number;
	source: 'user' | 'model';
	sourceThreadId?: string;
}

export interface ChatMemorySettings {
	savedMemories: boolean;
	referenceHistory: boolean;
}

/** A cache of conversation facts, valid only for the matching cleaned transcript. */
export interface ThreadMemorySummary {
	content: string;
	sourceRevision: string;
	generatedAt: number;
	model: string;
}

export const MAX_SAVED_MEMORIES = 256;
export const MAX_MEMORY_CONTENT = 4000;
export const MAX_MEMORY_SUMMARY = 4000;
