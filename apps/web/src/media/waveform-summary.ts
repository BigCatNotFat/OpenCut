"use client";

import { getSourceTimeAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline";

const RMS_ANALYSIS_WINDOW_SECONDS = 0.02;
const DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE = 128;
const STREAMING_SOURCE_WAVEFORM_BUCKET_SIZE = 256;

function computePeakBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	const channels = buffer.numberOfChannels;
	const channelData: Float32Array[] = Array.from({ length: channels }, (_, c) =>
		buffer.getChannelData(c),
	);

	return buckets.map(({ bucketStart, bucketEnd }) => {
		let peak = 0;
		for (let c = 0; c < channels; c++) {
			const data = channelData[c];
			for (let j = bucketStart; j < bucketEnd; j++) {
				const abs = Math.abs(data[j] ?? 0);
				if (abs > peak) {
					peak = abs;
				}
			}
		}
		return peak;
	});
}

export interface SampleBucket {
	bucketStart: number;
	bucketEnd: number;
}

export interface SourceWaveformSummary {
	sourceKey: string;
	sampleRate: number;
	totalSamples: number;
	bucketSize: number;
	amplitudes: Float32Array;
}

export function buildWaveformSourceKey({
	kind,
	id,
}: {
	kind: "media" | "library";
	id: string;
}): string {
	return `${kind}:${id}`;
}

export function buildSourceWaveformSummary({
	sourceKey,
	buffer,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
}: {
	sourceKey: string;
	buffer: AudioBuffer;
	bucketSize?: number;
}): SourceWaveformSummary {
	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	const bucketCount = Math.max(1, Math.ceil(buffer.length / safeBucketSize));
	const amplitudes = computePeakBuckets({
		buffer,
		buckets: Array.from({ length: bucketCount }, (_, bucketIndex) => {
			const bucketStart = bucketIndex * safeBucketSize;
			const bucketEnd = Math.min(buffer.length, bucketStart + safeBucketSize);
			return { bucketStart, bucketEnd };
		}),
	});

	return {
		sourceKey,
		sampleRate: buffer.sampleRate,
		totalSamples: buffer.length,
		bucketSize: safeBucketSize,
		amplitudes: Float32Array.from(amplitudes),
	};
}

/**
 * Builds a compact waveform summary from decoded audio chunks without ever
 * joining the full source into one AudioBuffer. This is important for long
 * recordings and multi-gigabyte video files, where reading or decoding the
 * entire source into memory would otherwise fail.
 */
export async function buildStreamingSourceWaveformSummary({
	sourceKey,
	buffers,
	bucketSize = STREAMING_SOURCE_WAVEFORM_BUCKET_SIZE,
}: {
	sourceKey: string;
	buffers: AsyncIterable<AudioBuffer>;
	bucketSize?: number;
}): Promise<SourceWaveformSummary> {
	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	const amplitudes: number[] = [];
	let sampleRate: number | null = null;
	let totalSamples = 0;
	let samplesInBucket = 0;
	let bucketPeak = 0;

	for await (const buffer of buffers) {
		if (buffer.length <= 0 || buffer.numberOfChannels <= 0) continue;

		if (sampleRate === null) {
			sampleRate = buffer.sampleRate;
		} else if (buffer.sampleRate !== sampleRate) {
			throw new Error(
				`Waveform source sample rate changed from ${sampleRate} to ${buffer.sampleRate}`,
			);
		}

		const channels = Array.from(
			{ length: buffer.numberOfChannels },
			(_, channel) => buffer.getChannelData(channel),
		);
		let chunkOffset = 0;

		while (chunkOffset < buffer.length) {
			const samplesToTake = Math.min(
				safeBucketSize - samplesInBucket,
				buffer.length - chunkOffset,
			);
			const chunkEnd = chunkOffset + samplesToTake;

			for (const channelData of channels) {
				for (let sample = chunkOffset; sample < chunkEnd; sample++) {
					const amplitude = Math.abs(channelData[sample] ?? 0);
					if (amplitude > bucketPeak) bucketPeak = amplitude;
				}
			}

			chunkOffset = chunkEnd;
			samplesInBucket += samplesToTake;
			totalSamples += samplesToTake;

			if (samplesInBucket === safeBucketSize) {
				amplitudes.push(bucketPeak);
				samplesInBucket = 0;
				bucketPeak = 0;
			}
		}
	}

	if (samplesInBucket > 0) amplitudes.push(bucketPeak);
	if (sampleRate === null || totalSamples <= 0) {
		throw new Error("The audio track did not produce any waveform samples");
	}

	return {
		sourceKey,
		sampleRate,
		totalSamples,
		bucketSize: safeBucketSize,
		amplitudes: Float32Array.from(amplitudes),
	};
}

export function buildWaveformSampleBuckets({
	clipLeftPx,
	clipRightPx,
	barCount,
	pixelsPerSecond,
	clipDurationSec,
	sourceStartSec,
	retime,
	sampleRate,
	maxSampleExclusive,
	barStepPx,
}: {
	clipLeftPx: number;
	clipRightPx: number;
	barCount: number;
	pixelsPerSecond: number;
	clipDurationSec: number;
	sourceStartSec: number;
	retime?: RetimeConfig;
	sampleRate: number;
	maxSampleExclusive: number;
	barStepPx: number;
}): SampleBucket[] {
	return Array.from({ length: barCount }, (_, index) => {
		const bucketLeftPx = clipLeftPx + index * barStepPx;
		const bucketRightPx = Math.min(clipRightPx, bucketLeftPx + barStepPx);
		const clipStartSec = Math.max(
			0,
			Math.min(clipDurationSec, bucketLeftPx / pixelsPerSecond),
		);
		const clipEndSec = Math.max(
			clipStartSec,
			Math.min(clipDurationSec, bucketRightPx / pixelsPerSecond),
		);
		const sourceBucketStartSec =
			sourceStartSec +
			getSourceTimeAtClipTime({
				clipTime: clipStartSec,
				retime,
			});
		const sourceBucketEndSec =
			sourceStartSec +
			getSourceTimeAtClipTime({
				clipTime: clipEndSec,
				retime,
			});

		return {
			bucketStart: Math.max(0, Math.floor(sourceBucketStartSec * sampleRate)),
			bucketEnd: Math.min(
				maxSampleExclusive,
				Math.max(0, Math.ceil(sourceBucketEndSec * sampleRate)),
			),
		};
	});
}

export function sampleSourceWaveformSummary({
	summary,
	buckets,
}: {
	summary: SourceWaveformSummary;
	buckets: SampleBucket[];
}): number[] {
	return buckets.map(({ bucketStart, bucketEnd }) => {
		if (bucketEnd <= bucketStart) {
			return 0;
		}

		const startIndex = Math.max(
			0,
			Math.floor(bucketStart / summary.bucketSize),
		);
		const endIndex = Math.min(
			summary.amplitudes.length,
			Math.max(startIndex + 1, Math.ceil(bucketEnd / summary.bucketSize)),
		);

		let maxAmplitude = 0;
		for (let i = startIndex; i < endIndex; i++) {
			const amplitude = summary.amplitudes[i] ?? 0;
			if (amplitude > maxAmplitude) {
				maxAmplitude = amplitude;
			}
		}

		return maxAmplitude;
	});
}

export function computeRmsBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	const channels = buffer.numberOfChannels;
	const maxWindowLength = Math.max(
		1,
		Math.floor(buffer.sampleRate * RMS_ANALYSIS_WINDOW_SECONDS),
	);

	const channelData: Float32Array[] = new Array(channels);
	for (let c = 0; c < channels; c++) {
		channelData[c] = buffer.getChannelData(c);
	}

	const result = new Array<number>(buckets.length);

	for (let i = 0; i < buckets.length; i++) {
		const { bucketStart, bucketEnd } = buckets[i];
		const bucketLength = bucketEnd - bucketStart;
		if (bucketLength <= 0) {
			result[i] = 0;
			continue;
		}

		const windowLength = Math.max(1, Math.min(bucketLength, maxWindowLength));
		let maxMeanSquare = 0;

		for (let winStart = bucketStart; winStart < bucketEnd; ) {
			const winEnd = Math.min(winStart + windowLength, bucketEnd);
			const n = winEnd - winStart;
			if (n > 0) {
				let sum = 0;
				for (let c = 0; c < channels; c++) {
					const data = channelData[c];
					for (let j = winStart; j < winEnd; j++) {
						const v = data[j];
						sum += v * v;
					}
				}
				const meanSquare = sum / (n * channels);
				if (meanSquare > maxMeanSquare) {
					maxMeanSquare = meanSquare;
				}
			}
			winStart = winEnd;
		}

		result[i] = Math.sqrt(maxMeanSquare);
	}

	return result;
}
