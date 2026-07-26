import { useReducer, useRef, useState } from "react";
import { AlertCircleIcon, CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { extractTimelineAudio } from "@/media/mediabunny";
import { useEditor } from "@/editor/use-editor";
import { TRANSCRIPTION_DIAGNOSTICS_SCOPE } from "@/transcription/diagnostics";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type {
	CaptionChunk,
	SubtitleSegmentationPreset,
	TranscriptionLanguage,
} from "@/transcription/types";
import {
	assertLocalSubtitleServiceReady,
	transcribeTimelineWithQwen,
} from "@/services/transcription/local-qwen-service";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import type { DiagnosticSeverity } from "@/diagnostics/types";
import { mediaTimeToSeconds } from "@/wasm";

const MAX_SINGLE_PASS_SUBTITLE_SECONDS = 30 * 60;
const MIN_CAPTION_DURATION_SECONDS = 0.08;

const DIAGNOSTIC_BUTTON_VARIANT: Record<
	DiagnosticSeverity,
	"caution" | "destructive-foreground"
> = {
	caution: "caution",
	error: "destructive-foreground",
};

const LANGUAGE_LABELS: Partial<Record<TranscriptionLanguage, string>> = {
	auto: "自动识别",
	zh: "中文",
	en: "英语",
	ja: "日语",
	es: "西班牙语",
	it: "意大利语",
	fr: "法语",
	de: "德语",
	pt: "葡萄牙语",
	ru: "俄语",
};

const SEGMENTATION_OPTIONS: Array<{
	value: SubtitleSegmentationPreset;
	label: string;
	description: string;
}> = [
	{ value: "short", label: "短句", description: "适合短视频和快节奏口播" },
	{ value: "standard", label: "标准", description: "适合大多数中文视频" },
	{ value: "long", label: "长句", description: "适合课程、访谈和演讲" },
];

type ProcessingState =
	| {
			status: "idle";
			error: string | null;
			warnings: string[];
			notice: string | null;
	  }
	| { status: "processing"; step: string };

type ProcessingAction =
	| { type: "start"; step: string }
	| { type: "update_step"; step: string }
	| { type: "succeed"; warnings: string[]; notice: string }
	| { type: "cancelled" }
	| { type: "fail"; error: string };

const IDLE_STATE: ProcessingState = {
	status: "idle",
	error: null,
	warnings: [],
	notice: null,
};

/* eslint-disable opencut/prefer-object-params -- React reducers must accept (state, action). */
function processingReducer(
	state: ProcessingState,
	action: ProcessingAction,
): ProcessingState {
	switch (action.type) {
		case "start":
			return { status: "processing", step: action.step };
		case "update_step":
			if (state.status !== "processing") return state;
			return { status: "processing", step: action.step };
		case "succeed":
			return {
				status: "idle",
				error: null,
				warnings: action.warnings,
				notice: action.notice,
			};
		case "cancelled":
			return {
				status: "idle",
				error: null,
				warnings: [],
				notice: "已取消自动字幕识别。",
			};
		case "fail":
			return {
				status: "idle",
				error: action.error,
				warnings: [],
				notice: null,
			};
	}
}
/* eslint-enable opencut/prefer-object-params */

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

export function Captions() {
	const [selectedLanguage, setSelectedLanguage] =
		useState<TranscriptionLanguage>("zh");
	const [segmentationPreset, setSegmentationPreset] =
		useState<SubtitleSegmentationPreset>("standard");
	const [processing, dispatch] = useReducer(processingReducer, IDLE_STATE);
	const containerRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const abortControllerRef = useRef<AbortController | null>(null);
	const editor = useEditor();

	const isProcessing = processing.status === "processing";
	const activeDiagnostics = useEditor((e) =>
		e.diagnostics.getActive({ scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE }),
	);

	const insertCaptions = ({
		captions,
		trackName,
	}: {
		captions: CaptionChunk[];
		trackName: string;
	}): boolean => {
		const trackId = insertCaptionChunksAsTextTrack({
			editor,
			captions,
			trackName,
		});
		return trackId !== null;
	};

	const handleGenerateTranscript = async () => {
		const abortController = new AbortController();
		abortControllerRef.current = abortController;
		dispatch({ type: "start", step: "正在提取时间线音频…" });

		try {
			const totalDuration = editor.timeline.getTotalDuration();
			const totalDurationSeconds = mediaTimeToSeconds({ time: totalDuration });
			if (totalDurationSeconds > MAX_SINGLE_PASS_SUBTITLE_SECONDS) {
				throw new Error(
					"当前版本单次自动字幕最多处理 30 分钟。请先裁剪时间线，长视频分块识别会在后续版本加入。",
				);
			}

			const audioBlob = await extractTimelineAudio({
				tracks: editor.scenes.getActiveScene().tracks,
				mediaAssets: editor.media.getAssets(),
				totalDuration,
				onProgress: (progress) => {
					dispatch({
						type: "update_step",
						step: `正在提取时间线音频 ${Math.round(progress)}%`,
					});
				},
			});

			abortController.signal.throwIfAborted();
			dispatch({ type: "update_step", step: "正在连接本地 Qwen3-ASR…" });
			await assertLocalSubtitleServiceReady({ signal: abortController.signal });

			dispatch({
				type: "update_step",
				step: "正在识别语音并匹配字幕时间…",
			});
			const result = await transcribeTimelineWithQwen({
				audioBlob,
				language: selectedLanguage,
				segmentationPreset,
				signal: abortController.signal,
			});

			dispatch({ type: "update_step", step: "正在生成时间线字幕…" });
			const captionChunks: CaptionChunk[] = result.cues
				.map((cue) => {
					const latestStart = Math.max(
						0,
						totalDurationSeconds - MIN_CAPTION_DURATION_SECONDS,
					);
					const startTime = Math.min(Math.max(0, cue.start), latestStart);
					const endTime = Math.min(
						totalDurationSeconds,
						Math.max(startTime + MIN_CAPTION_DURATION_SECONDS, cue.end),
					);
					return {
						text: cue.text,
						startTime,
						duration: Math.max(0, endTime - startTime),
					};
				})
				.filter((caption) => caption.duration > 0);

			if (
				!insertCaptions({
					captions: captionChunks,
					trackName: `自动字幕 · ${result.language || "未知语言"}`,
				})
			) {
				dispatch({ type: "fail", error: "没有生成可插入时间线的字幕。" });
				return;
			}

			dispatch({
				type: "succeed",
				warnings: [],
				notice: `已生成 ${captionChunks.length} 条自动字幕，可直接在时间线上编辑。`,
			});
		} catch (error) {
			if (isAbortError(error)) {
				dispatch({ type: "cancelled" });
				return;
			}
			console.error("Local Qwen subtitle transcription failed:", error);
			dispatch({
				type: "fail",
				error: error instanceof Error ? error.message : "自动字幕识别发生未知错误。",
			});
		} finally {
			abortControllerRef.current = null;
		}
	};

	const handleCancel = () => {
		abortControllerRef.current?.abort();
	};

	const handleImportClick = () => {
		fileInputRef.current?.click();
	};

	const handleImportFile = async ({ file }: { file: File }) => {
		dispatch({ type: "start", step: "正在读取字幕文件…" });
		try {
			const input = await file.text();
			const result = parseSubtitleFile({ fileName: file.name, input });

			if (result.captions.length === 0) {
				dispatch({ type: "fail", error: "字幕文件中没有有效字幕。" });
				return;
			}

			dispatch({ type: "update_step", step: "正在导入字幕…" });
			if (
				!insertCaptions({
					captions: result.captions,
					trackName: `导入字幕 · ${file.name}`,
				})
			) {
				dispatch({ type: "fail", error: "没有生成可插入的字幕。" });
				return;
			}

			const nextWarnings = [...result.warnings];
			if (result.skippedCueCount > 0) {
				nextWarnings.unshift(
					`已跳过 ${result.skippedCueCount} 条格式异常的字幕。`,
				);
			}

			dispatch({
				type: "succeed",
				warnings: nextWarnings,
				notice: `已导入 ${result.captions.length} 条字幕。`,
			});
		} catch (error) {
			console.error("Subtitle import failed:", error);
			dispatch({
				type: "fail",
				error: error instanceof Error ? error.message : "字幕导入发生未知错误。",
			});
		}
	};

	const handleFileChange = async ({
		event,
	}: {
		event: React.ChangeEvent<HTMLInputElement>;
	}) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		await handleImportFile({ file });
	};

	const handleLanguageChange = ({ value }: { value: string }) => {
		if (value === "auto") {
			setSelectedLanguage("auto");
			return;
		}
		const matchedLanguage = TRANSCRIPTION_LANGUAGES.find(
			(language) => language.code === value,
		);
		if (matchedLanguage) setSelectedLanguage(matchedLanguage.code);
	};

	const handleSegmentationChange = ({ value }: { value: string }) => {
		const matchedOption = SEGMENTATION_OPTIONS.find(
			(option) => option.value === value,
		);
		if (matchedOption) setSegmentationPreset(matchedOption.value);
	};

	const error = processing.status === "idle" ? processing.error : null;
	const warnings = processing.status === "idle" ? processing.warnings : [];
	const notice = processing.status === "idle" ? processing.notice : null;

	return (
		<PanelView
			title="自动字幕"
			contentClassName="px-0 flex flex-col h-full"
			actions={
				<TooltipProvider>
					<div className="flex items-center gap-1.5">
						{!isProcessing &&
							activeDiagnostics.map((diagnostic) => (
								<Tooltip key={diagnostic.id}>
									<TooltipTrigger asChild>
										<Button
											variant={DIAGNOSTIC_BUTTON_VARIANT[diagnostic.severity]}
											size="icon"
											aria-label={diagnostic.message}
										>
											<HugeiconsIcon icon={AlertCircleIcon} size={16} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>{diagnostic.message}</TooltipContent>
								</Tooltip>
							))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleImportClick}
							disabled={isProcessing}
							className="items-center justify-center gap-1.5"
						>
							<HugeiconsIcon icon={CloudUploadIcon} />
							导入字幕
						</Button>
					</div>
				</TooltipProvider>
			}
			ref={containerRef}
		>
			<input
				ref={fileInputRef}
				type="file"
				accept=".srt,.ass"
				className="hidden"
				onChange={(event) => void handleFileChange({ event })}
			/>
			<Section
				showTopBorder={false}
				showBottomBorder={false}
				className="flex-1"
			>
				<SectionContent className="flex h-full flex-col gap-4 pt-1">
					<div className="text-muted-foreground text-xs leading-5">
						使用本机 Qwen3-ASR 识别整条时间线，并按真实语音时间生成可编辑字幕块。
					</div>

					<SectionFields>
						<SectionField label="识别语言">
							<Select
								value={selectedLanguage}
								onValueChange={(value) => handleLanguageChange({ value })}
							>
								<SelectTrigger>
									<SelectValue placeholder="选择识别语言" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">自动识别</SelectItem>
									{TRANSCRIPTION_LANGUAGES.map((language) => (
										<SelectItem key={language.code} value={language.code}>
											{LANGUAGE_LABELS[language.code] ?? language.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>

						<SectionField label="字幕断句">
							<Select
								value={segmentationPreset}
								onValueChange={(value) =>
									handleSegmentationChange({ value })
								}
							>
								<SelectTrigger>
									<SelectValue placeholder="选择字幕断句方式" />
								</SelectTrigger>
								<SelectContent>
									{SEGMENTATION_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
					</SectionFields>

					<div className="bg-muted/40 rounded-md border p-3 text-xs">
						{
							SEGMENTATION_OPTIONS.find(
								(option) => option.value === segmentationPreset,
							)?.description
						}
					</div>

					<div className="mt-auto space-y-3">
						<Button
							type="button"
							variant={isProcessing ? "outline" : "default"}
							className="w-full"
							onClick={
								isProcessing ? handleCancel : () => void handleGenerateTranscript()
							}
							disabled={!isProcessing && activeDiagnostics.length > 0}
						>
							{isProcessing && <Spinner className="mr-1" />}
							{isProcessing ? `取消 · ${processing.step}` : "开始识别字幕"}
						</Button>

						{notice && (
							<div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3">
								<p className="text-sm text-emerald-700">{notice}</p>
							</div>
						)}
						{error && (
							<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
								<p className="text-destructive text-sm">{error}</p>
							</div>
						)}
						{warnings.length > 0 && (
							<div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
								<ul className="space-y-1 text-sm text-amber-700">
									{warnings.map((warning) => (
										<li key={warning}>{warning}</li>
									))}
								</ul>
							</div>
						)}
					</div>
				</SectionContent>
			</Section>
		</PanelView>
	);
}
