import type {
	LocalSubtitleTranscriptionResult,
	SubtitleSegmentationPreset,
	TranscriptionLanguage,
} from "@/transcription/types";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";

const LOCAL_AI_BASE_URL = "http://127.0.0.1:7860";
const LOCAL_AI_STATUS_URL = `${LOCAL_AI_BASE_URL}/api/status`;
const LOCAL_SUBTITLE_URL = `${LOCAL_AI_BASE_URL}/api/asr/subtitles`;

interface LocalAiStatus {
	capabilities?: {
		subtitle_timestamps?: boolean;
	};
	models?: {
		asr?: boolean;
		forced_aligner?: boolean;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseLocalAiStatus(value: unknown): LocalAiStatus {
	if (!isRecord(value)) return {};
	const capabilities = isRecord(value.capabilities)
		? {
				subtitle_timestamps:
					typeof value.capabilities.subtitle_timestamps === "boolean"
						? value.capabilities.subtitle_timestamps
						: undefined,
			}
		: undefined;
	const models = isRecord(value.models)
		? {
				asr:
					typeof value.models.asr === "boolean" ? value.models.asr : undefined,
				forced_aligner:
					typeof value.models.forced_aligner === "boolean"
						? value.models.forced_aligner
						: undefined,
			}
		: undefined;
	return { capabilities, models };
}

function isLocalSubtitleResult(
	value: unknown,
): value is LocalSubtitleTranscriptionResult {
	if (!isRecord(value)) return false;
	return (
		typeof value.text === "string" &&
		typeof value.language === "string" &&
		(value.segmentationPreset === "short" ||
			value.segmentationPreset === "standard" ||
			value.segmentationPreset === "long") &&
		Array.isArray(value.words) &&
		Array.isArray(value.cues)
	);
}

function resolveQwenLanguage({
	language,
}: {
	language: TranscriptionLanguage;
}): string {
	if (language === "auto") return "auto";
	return (
		TRANSCRIPTION_LANGUAGES.find((candidate) => candidate.code === language)
			?.name ?? "auto"
	);
}

async function readErrorMessage({ response }: { response: Response }) {
	try {
		const payload: unknown = await response.json();
		if (
			isRecord(payload) &&
			typeof payload.detail === "string" &&
			payload.detail.trim()
		) {
			return payload.detail;
		}
	} catch {
		// Fall back to the HTTP status below.
	}
	return `本地字幕服务请求失败（HTTP ${response.status}）`;
}

export async function assertLocalSubtitleServiceReady({
	signal,
}: {
	signal?: AbortSignal;
} = {}): Promise<void> {
	let response: Response;
	try {
		response = await fetch(LOCAL_AI_STATUS_URL, { signal });
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		throw new Error(
			"无法连接本地 Qwen3-ASR 服务，请确认桌面版 AI 后端已经启动。",
		);
	}

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	const status = parseLocalAiStatus(await response.json());
	if (!status.models?.asr) {
		throw new Error("未找到 Qwen3-ASR-1.7B 模型。请检查本地 models 目录。");
	}
	if (!status.models?.forced_aligner) {
		throw new Error(
			"未找到 Qwen3-ForcedAligner-0.6B，暂时无法生成精确字幕时间。",
		);
	}
	if (!status.capabilities?.subtitle_timestamps) {
		throw new Error("当前本地 AI 后端版本不支持自动字幕时间戳。");
	}
}

export async function transcribeTimelineWithQwen({
	audioBlob,
	language,
	segmentationPreset,
	signal,
}: {
	audioBlob: Blob;
	language: TranscriptionLanguage;
	segmentationPreset: SubtitleSegmentationPreset;
	signal?: AbortSignal;
}): Promise<LocalSubtitleTranscriptionResult> {
	const formData = new FormData();
	formData.append("audio", audioBlob, "opencut-timeline.wav");
	formData.append("language", resolveQwenLanguage({ language }));
	formData.append("segmentation_preset", segmentationPreset);

	let response: Response;
	try {
		response = await fetch(LOCAL_SUBTITLE_URL, {
			method: "POST",
			body: formData,
			signal,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		throw new Error("自动字幕识别失败：本地 Qwen3-ASR 服务连接已中断。");
	}

	if (!response.ok) {
		throw new Error(await readErrorMessage({ response }));
	}

	const result: unknown = await response.json();
	if (!isLocalSubtitleResult(result)) {
		throw new Error("本地字幕服务返回了无法识别的数据格式。");
	}
	if (result.cues.length === 0) {
		throw new Error("没有识别到可生成字幕的语音内容。");
	}
	return result;
}
