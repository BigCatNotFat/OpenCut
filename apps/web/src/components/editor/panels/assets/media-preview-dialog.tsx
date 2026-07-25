"use client";

import { useEffect, useMemo, useRef } from "react";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { MediaAsset } from "@/media/types";
import { cn } from "@/utils/ui";
import { HugeiconsIcon } from "@hugeicons/react";
import { Image02Icon, MusicNote03Icon } from "@hugeicons/core-free-icons";

export function MediaPreviewDialog({
	asset,
	onOpenChange,
}: {
	asset: MediaAsset | null;
	onOpenChange: (open: boolean) => void;
}) {
	const mediaRef = useRef<HTMLMediaElement | null>(null);
	const source = useMemo(() => {
		if (!asset) return { url: null, shouldRevoke: false };
		if (asset.url) return { url: asset.url, shouldRevoke: false };
		return { url: URL.createObjectURL(asset.file), shouldRevoke: true };
	}, [asset]);

	useEffect(() => {
		return () => {
			mediaRef.current?.pause();
			if (source.shouldRevoke && source.url) {
				URL.revokeObjectURL(source.url);
			}
		};
	}, [source]);

	return (
		<Dialog open={asset !== null} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex max-h-[92vh] max-w-5xl flex-col overflow-hidden p-0"
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
				<DialogHeader className="min-w-0 pr-16">
					<DialogTitle className="truncate" title={asset?.name}>
						{asset?.name ?? "Preview asset"}
					</DialogTitle>
				</DialogHeader>

				<DialogBody className="min-h-0 flex-1 bg-black p-0">
					{asset && source.url ? (
						<PreviewContent
							asset={asset}
							url={source.url}
							mediaRef={mediaRef}
						/>
					) : (
						<div className="text-muted-foreground flex min-h-80 items-center justify-center">
							Unable to preview this file
						</div>
					)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function PreviewContent({
	asset,
	url,
	mediaRef,
}: {
	asset: MediaAsset;
	url: string;
	mediaRef: React.MutableRefObject<HTMLMediaElement | null>;
}) {
	if (asset.type === "video") {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center">
				<video
					ref={(node) => {
						mediaRef.current = node;
					}}
					src={url}
					className="max-h-[calc(92vh-6rem)] max-w-full object-contain"
					controls
					autoPlay
					playsInline
					preload="metadata"
				/>
			</div>
		);
	}

	if (asset.type === "audio") {
		return (
			<div className="flex min-h-80 w-full flex-col items-center justify-center gap-8 px-8">
				<div className="bg-muted/20 text-white/80 flex size-28 items-center justify-center rounded-full">
					<HugeiconsIcon icon={MusicNote03Icon} className="size-14" />
				</div>
				<audio
					ref={(node) => {
						mediaRef.current = node;
					}}
					src={url}
					className="w-full max-w-2xl"
					controls
					autoPlay
					preload="metadata"
				/>
			</div>
		);
	}

	if (asset.type === "image") {
		return (
			<div className="flex min-h-80 flex-1 items-center justify-center overflow-auto p-4">
				{/* The image is a local object URL, so a regular img avoids Next image sizing constraints. */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					src={url}
					alt={asset.name}
					className="max-h-[calc(92vh-7rem)] max-w-full object-contain"
				/>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"text-muted-foreground flex min-h-80 flex-col items-center justify-center gap-3",
			)}
		>
			<HugeiconsIcon icon={Image02Icon} className="size-12" />
			<span>Unable to preview this file</span>
		</div>
	);
}
