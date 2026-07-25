"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Plus, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";

const MIN_SELECTION_SECONDS = 0.04;

function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "00:00.00";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);
	const centiseconds = Math.floor((seconds % 1) * 100);
	const base = `${minutes.toString().padStart(2, "0")}:${secs
		.toString()
		.padStart(2, "0")}.${centiseconds.toString().padStart(2, "0")}`;
	return hours > 0 ? `${hours.toString().padStart(2, "0")}:${base}` : base;
}

export function SourceMonitor({
	onToggleFullscreen,
}: {
	onToggleFullscreen: () => void;
}) {
	const editor = useEditor();
	const previewMediaId = useAssetsPanelStore((state) => state.previewMediaId);
	const closeMediaPreview = useAssetsPanelStore(
		(state) => state.closeMediaPreview,
	);
	const asset = useEditor(
		(instance) =>
			instance.media
				.getAssets()
				.find((mediaAsset) => mediaAsset.id === previewMediaId) ?? null,
	);
	const mediaElementRef = useRef<HTMLMediaElement | null>(null);
	const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
	const [duration, setDuration] = useState(asset?.duration ?? 0);
	const [currentTime, setCurrentTime] = useState(0);
	const [inPoint, setInPoint] = useState(0);
	const [outPoint, setOutPoint] = useState(asset?.duration ?? 0);
	const [isPlaying, setIsPlaying] = useState(false);

	useEffect(() => {
		if (!asset) {
			closeMediaPreview();
			return;
		}
		const nextDuration = asset.duration ?? 0;
		setDuration(nextDuration);
		setCurrentTime(0);
		setInPoint(0);
		setOutPoint(nextDuration);
		setIsPlaying(false);
	}, [asset?.id, asset?.duration, closeMediaPreview]);

	useEffect(() => {
		if (!asset || asset.url) {
			setFallbackUrl(null);
			return;
		}
		const objectUrl = URL.createObjectURL(asset.file);
		setFallbackUrl(objectUrl);
		return () => URL.revokeObjectURL(objectUrl);
	}, [asset]);

	useEffect(
		() => () => {
			mediaElementRef.current?.pause();
		},
		[],
	);

	const sourceUrl = asset?.url ?? fallbackUrl ?? "";
	const hasTimedMedia = asset?.type === "video" || asset?.type === "audio";
	const safeDuration = Math.max(duration, 0);
	const selectedDuration = Math.max(outPoint - inPoint, 0);
	const inPercent = safeDuration > 0 ? (inPoint / safeDuration) * 100 : 0;
	const outPercent = safeDuration > 0 ? (outPoint / safeDuration) * 100 : 100;

	const mediaView = useMemo(() => {
		if (!asset) return null;
		if (asset.type === "image") {
			return (
				<img
					src={sourceUrl}
					alt={asset.name}
					className="max-h-full max-w-full object-contain"
				/>
			);
		}

		const commonProps = {
			src: sourceUrl,
			preload: "metadata" as const,
			onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) => {
				const mediaDuration = event.currentTarget.duration;
				if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
					setDuration(mediaDuration);
					setOutPoint(mediaDuration);
				}
			},
			onTimeUpdate: (event: React.SyntheticEvent<HTMLMediaElement>) => {
				const media = event.currentTarget;
				if (!media.paused && media.currentTime >= outPoint) {
					media.pause();
					media.currentTime = outPoint;
					setIsPlaying(false);
					setCurrentTime(outPoint);
					return;
				}
				setCurrentTime(media.currentTime);
			},
			onPlay: () => setIsPlaying(true),
			onPause: () => setIsPlaying(false),
			onEnded: () => setIsPlaying(false),
		};

		if (asset.type === "video") {
			return (
				<video
					ref={(node) => {
						mediaElementRef.current = node;
					}}
					className="max-h-full max-w-full bg-black object-contain"
					{...commonProps}
				/>
			);
		}

		return (
			<div className="flex flex-col items-center gap-5 text-center">
				<div className="bg-muted flex size-28 items-center justify-center rounded-full text-4xl">
					♫
				</div>
				<div className="max-w-lg truncate text-sm text-white/80">{asset.name}</div>
				<audio
					ref={(node) => {
						mediaElementRef.current = node;
					}}
					{...commonProps}
				/>
			</div>
		);
	}, [asset, sourceUrl, outPoint]);

	if (!asset) return null;

	const seekTo = (seconds: number) => {
		const nextTime = Math.max(0, Math.min(safeDuration, seconds));
		if (mediaElementRef.current) mediaElementRef.current.currentTime = nextTime;
		setCurrentTime(nextTime);
	};

	const togglePlayback = async () => {
		const media = mediaElementRef.current;
		if (!media) return;
		if (!media.paused) {
			media.pause();
			return;
		}
		if (media.currentTime < inPoint || media.currentTime >= outPoint) {
			media.currentTime = inPoint;
			setCurrentTime(inPoint);
		}
		try {
			await media.play();
		} catch (error) {
			console.error("Failed to play source media:", error);
		}
	};

	const markIn = () => {
		const nextIn = Math.min(currentTime, outPoint - MIN_SELECTION_SECONDS);
		setInPoint(Math.max(0, nextIn));
	};

	const markOut = () => {
		const nextOut = Math.max(currentTime, inPoint + MIN_SELECTION_SECONDS);
		setOutPoint(Math.min(safeDuration, nextOut));
	};

	const resetSelection = () => {
		setInPoint(0);
		setOutPoint(safeDuration);
	};

	const addSelectionToTimeline = () => {
		const startTime = editor.playback.getCurrentTime();
		const sourceDuration =
			asset.type === "image"
				? DEFAULT_NEW_ELEMENT_DURATION
				: mediaTimeFromSeconds({ seconds: safeDuration });
		const baseElement = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration: sourceDuration,
			startTime,
		});
		const element =
			asset.type === "image"
				? baseElement
				: {
						...baseElement,
						duration: mediaTimeFromSeconds({ seconds: selectedDuration }),
						trimStart: mediaTimeFromSeconds({ seconds: inPoint }),
						trimEnd: mediaTimeFromSeconds({
							seconds: Math.max(0, safeDuration - outPoint),
						}),
						sourceDuration,
					};

		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
		toast.success(
			asset.type === "image"
				? "图片已添加到时间线"
				: `已添加选区 ${formatTime(selectedDuration)}`,
		);
	};

	return (
		<div className="flex size-full min-h-0 flex-col" data-source-monitor>
			<div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
				<div className="min-w-0">
					<div className="text-muted-foreground text-xs">素材预览</div>
					<div className="max-w-[50vw] truncate text-sm font-medium">{asset.name}</div>
				</div>
				<div className="flex items-center gap-2">
					<Button variant="ghost" size="sm" onClick={onToggleFullscreen}>
						全屏
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={closeMediaPreview}
						title="返回时间线预览"
					>
						<X className="size-4" />
					</Button>
				</div>
			</div>

			<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-3">
				{mediaView}
			</div>

			<div className="shrink-0 border-t p-3">
				{hasTimedMedia ? (
					<>
						<div className="mb-2 flex items-center gap-3">
							<Button variant="ghost" size="icon" onClick={togglePlayback}>
								{isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
							</Button>
							<div className="relative flex-1">
								<div className="bg-muted absolute top-1/2 h-1 w-full -translate-y-1/2 rounded" />
								<div
									className="bg-primary/55 absolute top-1/2 h-2 -translate-y-1/2 rounded"
									style={{ left: `${inPercent}%`, width: `${Math.max(0, outPercent - inPercent)}%` }}
								/>
								<input
									type="range"
									min={0}
									max={Math.max(safeDuration, 0.01)}
									step={0.01}
									value={Math.min(currentTime, safeDuration)}
									onChange={(event) => seekTo(Number(event.currentTarget.value))}
									className="relative z-10 w-full accent-white"
									aria-label="素材预览进度"
								/>
							</div>
							<div className="w-32 text-right font-mono text-xs">
								{formatTime(currentTime)} / {formatTime(safeDuration)}
							</div>
						</div>

						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex flex-wrap items-center gap-2">
								<Button variant="outline" size="sm" onClick={markIn}>
									设为入点&nbsp; {formatTime(inPoint)}
								</Button>
								<Button variant="outline" size="sm" onClick={markOut}>
									设为出点&nbsp; {formatTime(outPoint)}
								</Button>
								<Button variant="ghost" size="sm" onClick={resetSelection}>
									<RotateCcw className="mr-1 size-4" />清除区间
								</Button>
							</div>
							<Button
								size="sm"
								onClick={addSelectionToTimeline}
								disabled={selectedDuration < MIN_SELECTION_SECONDS}
							>
								<Plus className="mr-1 size-4" />添加选区到时间线
							</Button>
						</div>
					</>
				) : (
					<div className="flex justify-end">
						<Button size="sm" onClick={addSelectionToTimeline}>
							<Plus className="mr-1 size-4" />添加图片到时间线
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
