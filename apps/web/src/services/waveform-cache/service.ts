"use client";

import { createAudioContext } from "@/media/audio";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import {
	buildSourceWaveformSummary,
	buildStreamingSourceWaveformSummary,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";

const MAX_WEB_AUDIO_DECODE_BYTES = 64 * 1024 * 1024;
const WAVEFORM_CACHE_DB_NAME = "opencut-waveform-cache";
const WAVEFORM_CACHE_STORE_NAME = "summaries";
const WAVEFORM_CACHE_VERSION = 1;

interface StoredWaveformSummary {
	id: string;
	fingerprint: string;
	sampleRate: number;
	totalSamples: number;
	bucketSize: number;
	amplitudes: Float32Array;
}

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: File;
	audioUrl?: string;
}

export class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.loadOrBuildSummary({
			sourceKey,
			audioBuffer,
			sourceFile,
			audioUrl,
		}).catch((error) => {
			this.summaries.delete(sourceKey);
			throw error;
		});

		this.summaries.set(sourceKey, promise);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
		void deleteStoredWaveformSummary({ sourceKey });
	}

	clearAll(): void {
		this.summaries.clear();
	}

	private async loadOrBuildSummary(
		args: GetSourceWaveformSummaryArgs,
	): Promise<SourceWaveformSummary> {
		const stored = await getStoredWaveformSummary({
			sourceKey: args.sourceKey,
		});
		if (stored) {
			return {
				sourceKey: args.sourceKey,
				sampleRate: stored.sampleRate,
				totalSamples: stored.totalSamples,
				bucketSize: stored.bucketSize,
				amplitudes:
					stored.amplitudes instanceof Float32Array
						? stored.amplitudes
						: new Float32Array(stored.amplitudes),
			};
		}

		const summary = await this.buildSummary(args);
		await setStoredWaveformSummary({
			record: {
				id: args.sourceKey,
				fingerprint: args.sourceKey,
				sampleRate: summary.sampleRate,
				totalSamples: summary.totalSamples,
				bucketSize: summary.bucketSize,
				amplitudes: summary.amplitudes,
			},
		});
		return summary;
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return buildSourceWaveformSummary({ sourceKey, buffer: audioBuffer });
		}

		let sourceBlob: Blob | null = sourceFile ?? null;
		if (!sourceBlob && audioUrl) {
			const response = await fetch(audioUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch waveform source: ${response.status}`);
			}
			sourceBlob = await response.blob();
		}

		if (!sourceBlob) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		const shouldTryWebAudio =
			sourceBlob.size <= MAX_WEB_AUDIO_DECODE_BYTES &&
			!sourceBlob.type.toLowerCase().startsWith("video/");

		if (shouldTryWebAudio) {
			const audioContext = createAudioContext();
			try {
				const arrayBuffer = await sourceBlob.arrayBuffer();
				const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
				return buildSourceWaveformSummary({ sourceKey, buffer });
			} catch {
				// Fall through to the streaming demuxer. This covers valid AAC/M4A
				// sources that Chromium's decodeAudioData does not accept.
			} finally {
				void audioContext.close();
			}
		}

		return buildStreamingSourceWaveformSummary({
			sourceKey,
			buffers: decodeWaveformAudioChunks({ sourceBlob }),
		});
	}
}

async function openWaveformCacheDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(
			WAVEFORM_CACHE_DB_NAME,
			WAVEFORM_CACHE_VERSION,
		);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(WAVEFORM_CACHE_STORE_NAME)) {
				db.createObjectStore(WAVEFORM_CACHE_STORE_NAME, { keyPath: "id" });
			}
		};
	});
}

async function getStoredWaveformSummary({
	sourceKey,
}: {
	sourceKey: string;
}): Promise<StoredWaveformSummary | null> {
	try {
		const db = await openWaveformCacheDb();
		return await new Promise((resolve, reject) => {
			const transaction = db.transaction(
				WAVEFORM_CACHE_STORE_NAME,
				"readonly",
			);
			const request = transaction
				.objectStore(WAVEFORM_CACHE_STORE_NAME)
				.get(sourceKey);
			request.onerror = () => reject(request.error);
			request.onsuccess = () =>
				resolve((request.result as StoredWaveformSummary | undefined) ?? null);
			transaction.oncomplete = () => db.close();
			transaction.onabort = () => db.close();
		});
	} catch {
		return null;
	}
}

async function setStoredWaveformSummary({
	record,
}: {
	record: StoredWaveformSummary;
}): Promise<void> {
	try {
		const db = await openWaveformCacheDb();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(
				WAVEFORM_CACHE_STORE_NAME,
				"readwrite",
			);
			transaction.objectStore(WAVEFORM_CACHE_STORE_NAME).put(record);
			transaction.onerror = () => reject(transaction.error);
			transaction.oncomplete = () => {
				db.close();
				resolve();
			};
			transaction.onabort = () => {
				db.close();
				reject(transaction.error);
			};
		});
	} catch {
		// A waveform is still useful for the current session even if persistence
		// is unavailable (for example, private browsing or storage pressure).
	}
}

async function deleteStoredWaveformSummary({
	sourceKey,
}: {
	sourceKey: string;
}): Promise<void> {
	try {
		const db = await openWaveformCacheDb();
		await new Promise<void>((resolve) => {
			const transaction = db.transaction(
				WAVEFORM_CACHE_STORE_NAME,
				"readwrite",
			);
			transaction.objectStore(WAVEFORM_CACHE_STORE_NAME).delete(sourceKey);
			transaction.oncomplete = () => {
				db.close();
				resolve();
			};
			transaction.onabort = () => {
				db.close();
				resolve();
			};
		});
	} catch {
		// Ignore cache cleanup failures.
	}
}

async function* decodeWaveformAudioChunks({
	sourceBlob,
}: {
	sourceBlob: Blob;
}): AsyncGenerator<AudioBuffer, void, unknown> {
	const input = new Input({
		source: new BlobSource(sourceBlob),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	if (!audioTrack) {
		throw new Error("The media source does not contain an audio track");
	}

	const sink = new AudioBufferSink(audioTrack);
	for await (const { buffer } of sink.buffers(0)) {
		if (buffer.length <= 0) continue;
		yield buffer;
	}
}

export const waveformCache = new WaveformCache();
