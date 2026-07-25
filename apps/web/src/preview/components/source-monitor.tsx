"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
	BetweenHorizontalEnd,
	BetweenHorizontalStart,
	ListPlus,
	Maximize2,
	Pause,
	Play,
	Plus,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { addMediaTime, mediaTimeFromSeconds } from "@/wasm";

const MIN_SELECTION_SECONDS = 0.04;
const PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2, 3] as const;

interface SourceSelection {
	id: string;
	inPoint: number;
	outPoint: number;
}

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

function CompactTool({
	label,
	children,
}: {
	label: string;
	children: React.ReactElement;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
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
	const playbackRate = useAssetsPanelStore(
		(state) => state.sourcePlaybackRate,
	);
	const setPlaybackRate = useAssetsPanelStore(
		(state) => state.setSourcePlaybackRate,
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
	const [selections, setSelections] = useState<SourceSelection[]>([]);
	const [activeSelectionId, setActiveSelectionId] = useState<string | null>(
		null,
	);

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
		setSelections([]);
		setActiveSelectionId(null);
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

	useEffect(() => {
		if (mediaElementRef.current) {
			mediaElementRef.current.playbackRate = playbackRate;
		}
	}, [playbackRate, asset?.id]);

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
	const sortedSelections = useMemo(
		() => [...selections].sort((a, b) => a.inPoint - b.inPoint),
		[selections],
	);
	const totalSelectedDuration = useMemo(
		() =>
			sortedSelections.reduce(
				(total, selection) =>
					total + Math.max(0, selection.outPoint - selection.inPoint),
				0,
			),
		[sortedSelections],
	);

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
				const media = event.currentTarget;
				media.playbackRate = playbackRate;
				const mediaDuration = media.duration;
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
			<div className="flex flex-col items-center gap-4 text-center">
				<div className="bg-muted flex size-24 items-center justify-center rounded-full text-3xl">
					♫
				</div>
				<div className="max-w-lg truncate text-sm text-white/80">
					{asset.name}
				</div>
				<audio
					ref={(node) => {
						mediaElementRef.current = node;
					}}
					{...commonProps}
				/>
			</div>
		);
	}, [asset, sourceUrl, outPoint, playbackRate]);

	if (!asset) return null;

	const seekTo = (seconds: number) => {
		const nextTime = Math.max(0, Math.min(safeDuration, seconds));
		if (mediaElementRef.current) mediaElementRef.current.currentTime = nextTime;
		setCurrentTime(nextTime);
	};

	const playRange = async ({
		start,
		end,
		selectionId = null,
	}: {
		start: number;
		end: number;
		selectionId?: string | null;
	}) => {
		const media = mediaElementRef.current;
		if (!media) return;
		setInPoint(start);
		setOutPoint(end);
		setActiveSelectionId(selectionId);
		media.currentTime = start;
		media.playbackRate = playbackRate;
		setCurrentTime(start);
		try {
			await media.play();
		} catch (error) {
			console.error("Failed to play source media:", error);
		}
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
		media.playbackRate = playbackRate;
		try {
			await media.play();
		} catch (error) {
			console.error("Failed to play source media:", error);
		}
	};

	const markIn = () => {
		const nextIn = Math.min(currentTime, outPoint - MIN_SELECTION_SECONDS);
		setInPoint(Math.max(0, nextIn));
		setActiveSelectionId(null);
	};

	const markOut = () => {
		const nextOut = Math.max(currentTime, inPoint + MIN_SELECTION_SECONDS);
		setOutPoint(Math.min(safeDuration, nextOut));
		setActiveSelectionId(null);
	};

	const resetSelection = () => {
		setInPoint(0);
		setOutPoint(safeDuration);
		setActiveSelectionId(null);
	};

	const addCurrentSelection = () => {
		if (selectedDuration < MIN_SELECTION_SECONDS) return;
		const overlaps = selections.some(
			(selection) =>
				inPoint < selection.outPoint - MIN_SELECTION_SECONDS &&
				outPoint > selection.inPoint + MIN_SELECTION_SECONDS,
		);
		if (overlaps) {
			toast.error("当前区间与已有片段重叠");
			return;
		}

		const nextSelection: SourceSelection = {
			id: crypto.randomUUID(),
			inPoint,
			outPoint,
		};
		setSelections((current) => [...current, nextSelection]);
		setActiveSelectionId(nextSelection.id);
		toast.success(`已保存第 ${selections.length + 1} 段`);
	};

	const removeSelection = (selectionId: string) => {
		setSelections((current) =>
			current.filter((selection) => selection.id !== selectionId),
		);
		if (activeSelectionId === selectionId) setActiveSelectionId(null);
	};

	const clearSelections = () => {
		setSelections([]);
		setActiveSelectionId(null);
	};

	const addImageToTimeline = () => {
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration: DEFAULT_NEW_ELEMENT_DURATION,
			startTime: editor.playback.getCurrentTime(),
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
		toast.success("图片已添加到时间线");
	};

	const addRangesToTimeline = () => {
		const ranges =
			sortedSelections.length > 0
				? sortedSelections
				: [{ id: "current", inPoint, outPoint }];
		if (
			ranges.some(
				(range) => range.outPoint - range.inPoint < MIN_SELECTION_SECONDS,
			)
		) {
			return;
		}

		const sourceDuration = mediaTimeFromSeconds({ seconds: safeDuration });
		let nextStartTime = editor.playback.getCurrentTime();

		for (const [index, selection] of ranges.entries()) {
			const clipDuration = mediaTimeFromSeconds({
				seconds: selection.outPoint - selection.inPoint,
			});
			const baseElement = buildElementFromMedia({
				mediaId: asset.id,
				mediaType: asset.type,
				name:
					ranges.length > 1 ? `${asset.name} · 片段 ${index + 1}` : asset.name,
				duration: sourceDuration,
				startTime: nextStartTime,
			});
			const element = {
				...baseElement,
				duration: clipDuration,
				trimStart: mediaTimeFromSeconds({ seconds: selection.inPoint }),
				trimEnd: mediaTimeFromSeconds({
					seconds: Math.max(0, safeDuration - selection.outPoint),
				}),
				sourceDuration,
			};

			editor.timeline.insertElement({
				element,
				placement: { mode: "auto" },
			});
			nextStartTime = addMediaTime({ a: nextStartTime, b: clipDuration });
		}

		const totalDuration = ranges.reduce(
			(sum, range) => sum + range.outPoint - range.inPoint,
			0,
		);
		toast.success(
			ranges.length > 1
				? `已连续添加 ${ranges.length} 段，共 ${formatTime(totalDuration)}`
				: `已添加选区 ${formatTime(totalDuration)}`,
		);
	};

	return (
		<TooltipProvider delayDuration={250}>
			<div className="flex size-full min-h-0 flex-col" data-source-monitor>
				<div className="flex h-9 shrink-0 items-center justify-between border-b px-2.5">
					<div className="min-w-0 truncate text-xs font-medium" title={asset.name}>
						素材：{asset.name}
					</div>
					<div className="flex items-center gap-0.5">
						<CompactTool label="全屏预览">
							<Button
								variant="ghost"
								size="icon"
								className="size-7"
								onClick={onToggleFullscreen}
							>
								<Maximize2 className="size-3.5" />
							</Button>
						</CompactTool>
						<CompactTool label="返回时间线预览">
							<Button
								variant="ghost"
								size="icon"
								className="size-7"
								onClick={closeMediaPreview}
							>
								<X className="size-3.5" />
							</Button>
						</CompactTool>
					</div>
				</div>

				<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-2">
					{mediaView}
				</div>

				<div className="shrink-0 border-t bg-background">
					{hasTimedMedia ? (
						<>
							<div className="flex h-9 items-center gap-2 px-2">
								<Button
									variant="ghost"
									size="icon"
									className="size-7 shrink-0"
									onClick={togglePlayback}
									title={isPlaying ? "暂停" : "播放选区"}
								>
									{isPlaying ? (
										<Pause className="size-3.5" />
									) : (
										<Play className="size-3.5" />
									)}
								</Button>

								<span className="w-[68px] shrink-0 text-right font-mono text-[11px] tabular-nums">
									{formatTime(currentTime)}
								</span>

								<div className="relative flex-1">
									<div className="bg-muted absolute top-1/2 h-1 w-full -translate-y-1/2 rounded" />
									{sortedSelections.map((selection) => {
										const left = (selection.inPoint / safeDuration) * 100;
										const width =
											((selection.outPoint - selection.inPoint) / safeDuration) *
											100;
										return (
											<div
												key={selection.id}
												className="absolute top-1/2 h-2 -translate-y-1/2 rounded bg-emerald-500/65"
												style={{ left: `${left}%`, width: `${width}%` }}
											/>
										);
									})}
									<div
										className="bg-primary/70 absolute top-1/2 h-1.5 -translate-y-1/2 rounded"
										style={{
											left: `${inPercent}%`,
											width: `${Math.max(0, outPercent - inPercent)}%`,
										}}
									/>
									<input
										type="range"
										min={0}
										max={Math.max(safeDuration, 0.01)}
										step={0.01}
										value={Math.min(currentTime, safeDuration)}
										onChange={(event) =>
											seekTo(Number(event.currentTarget.value))
										}
										className="relative z-10 block h-5 w-full accent-white"
										aria-label="素材预览进度"
									/>
								</div>

								<span className="w-[68px] shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
									{formatTime(safeDuration)}
								</span>

								<select
									value={playbackRate}
									onChange={(event) =>
										setPlaybackRate(Number(event.currentTarget.value))
									}
									className="bg-accent border-input h-7 w-[58px] shrink-0 rounded border px-1 text-center text-[11px] outline-none"
									aria-label="素材预览播放速度"
									title="播放速度"
								>
									{PLAYBACK_RATES.map((rate) => (
										<option key={rate} value={rate}>
											{rate}×
										</option>
									))}
								</select>
							</div>

							<div className="flex h-9 items-center border-t px-2">
								<div className="flex items-center gap-0.5">
									<CompactTool label={`设为入点（${formatTime(inPoint)}）`}>
										<Button
											variant="ghost"
											size="icon"
											className="size-7"
											onClick={markIn}
											aria-label="设为入点"
										>
											<BetweenHorizontalStart className="size-3.5" />
										</Button>
									</CompactTool>
									<CompactTool label={`设为出点（${formatTime(outPoint)}）`}>
										<Button
											variant="ghost"
											size="icon"
											className="size-7"
											onClick={markOut}
											aria-label="设为出点"
										>
											<BetweenHorizontalEnd className="size-3.5" />
										</Button>
									</CompactTool>
									<CompactTool label="重置当前入点和出点">
										<Button
											variant="ghost"
											size="icon"
											className="size-7"
											onClick={resetSelection}
										>
											<RotateCcw className="size-3.5" />
										</Button>
									</CompactTool>
									<CompactTool label="保存当前区间为一个片段">
										<Button
											variant="ghost"
											size="icon"
											className="size-7"
											onClick={addCurrentSelection}
											disabled={selectedDuration < MIN_SELECTION_SECONDS}
											aria-label="保存当前片段"
										>
											<ListPlus className="size-3.5" />
										</Button>
									</CompactTool>
								</div>

								<div className="mx-2 h-4 w-px bg-border" />

								<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
									I {formatTime(inPoint)}&nbsp;&nbsp; O {formatTime(outPoint)}&nbsp;&nbsp;
									({formatTime(selectedDuration)})
								</span>

								<Popover>
									<PopoverTrigger asChild>
										<Button
											variant="ghost"
											size="sm"
											className="h-7 shrink-0 gap-1 px-2 text-xs"
											aria-label="查看已保存片段"
										>
											片段 {sortedSelections.length}
										</Button>
									</PopoverTrigger>
									<PopoverContent
										side="top"
										align="end"
										className="w-[360px] p-0"
									>
										<div className="flex items-center justify-between border-b px-3 py-2">
											<div>
												<div className="text-sm font-medium">
													已保存 {sortedSelections.length} 段
												</div>
												<div className="text-muted-foreground text-xs">
													总时长 {formatTime(totalSelectedDuration)}
												</div>
											</div>
											{sortedSelections.length > 0 ? (
												<Button
													variant="ghost"
													size="sm"
													className="h-7 text-xs"
													onClick={clearSelections}
												>
													清空
												</Button>
											) : null}
										</div>

										<div className="max-h-56 overflow-y-auto p-1">
											{sortedSelections.length > 0 ? (
												sortedSelections.map((selection, index) => (
													<div
														key={selection.id}
														className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs ${
															activeSelectionId === selection.id
																? "bg-accent"
																: "hover:bg-accent/60"
														}`}
													>
														<span className="w-7 shrink-0 font-medium">
															{index + 1}
														</span>
														<button
															type="button"
															className="min-w-0 flex-1 text-left font-mono"
															onClick={() =>
																playRange({
																	start: selection.inPoint,
																	end: selection.outPoint,
																	selectionId: selection.id,
																})
															}
														>
															{formatTime(selection.inPoint)} →{" "}
															{formatTime(selection.outPoint)}
														</button>
														<span className="text-muted-foreground w-[58px] text-right font-mono">
															{formatTime(
																selection.outPoint - selection.inPoint,
															)}
														</span>
														<Button
															variant="ghost"
															size="icon"
															className="size-6"
															onClick={() => removeSelection(selection.id)}
															title="删除片段"
														>
															<Trash2 className="size-3" />
														</Button>
													</div>
												))
											) : (
												<div className="text-muted-foreground px-3 py-6 text-center text-xs">
													使用入点和出点确定区间，再点击“保存当前片段”。
												</div>
											)}
										</div>

										{sortedSelections.length > 0 ? (
											<div className="border-t p-2">
												<Button
													size="sm"
													className="h-8 w-full text-xs"
													onClick={addRangesToTimeline}
												>
													<Plus className="mr-1 size-3.5" />
													连续插入 {sortedSelections.length} 段
												</Button>
											</div>
										) : null}
									</PopoverContent>
								</Popover>

								<CompactTool
									label={
										sortedSelections.length > 0
											? `连续插入 ${sortedSelections.length} 段`
											: "将当前入点到出点插入时间线"
									}
								>
									<Button
										size="icon"
										className="ml-1 size-7 shrink-0"
										onClick={addRangesToTimeline}
										disabled={
											sortedSelections.length === 0 &&
											selectedDuration < MIN_SELECTION_SECONDS
										}
										aria-label="插入时间线"
									>
										<Plus className="size-3.5" />
									</Button>
								</CompactTool>
							</div>
						</>
					) : (
						<div className="flex h-10 items-center justify-end px-2">
							<Button size="sm" className="h-7" onClick={addImageToTimeline}>
								<Plus className="mr-1 size-3.5" />添加到时间线
							</Button>
						</div>
					)}
				</div>
			</div>
		</TooltipProvider>
	);
}
