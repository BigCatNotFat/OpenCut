import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TrackType } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import {
	buildEmptyTrack,
	getDefaultInsertIndexForTrack,
} from "@/timeline/placement";

export class AddTrackCommand extends Command {
	private trackId: string;
	private savedState: SceneTracks | null = null;

	constructor({
		type,
		index,
		name,
	}: {
		type: TrackType;
		index?: number;
		name?: string;
	}) {
		super();
		this.type = type;
		this.index = index;
		this.name = name;
		this.trackId = generateUUID();
	}

	private type: TrackType;
	private index?: number;
	private name?: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const insertIndex =
			this.index ??
			getDefaultInsertIndexForTrack({
				tracks: this.savedState,
				trackType: this.type,
			});

		const updatedTracks =
			this.type === "audio"
				? buildAudioTrackState({
						tracks: this.savedState,
						insertIndex,
						trackId: this.trackId,
						trackName: this.name,
					})
				: buildOverlayTrackState({
						tracks: this.savedState,
						insertIndex,
						trackId: this.trackId,
						trackType: this.type,
						trackName: this.name,
					});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getTrackId(): string {
		return this.trackId;
	}
}

function buildAudioTrackState({
	tracks,
	insertIndex,
	trackId,
	trackName,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
	trackName?: string;
}): SceneTracks {
	const audioInsertIndex = Math.max(0, insertIndex - tracks.overlay.length - 1);
	const newTrack = buildEmptyTrack({
		id: trackId,
		type: "audio",
		name: trackName,
	});
	return {
		...tracks,
		audio: [
			...tracks.audio.slice(0, audioInsertIndex),
			newTrack,
			...tracks.audio.slice(audioInsertIndex),
		],
	};
}

function buildOverlayTrackState({
	tracks,
	insertIndex,
	trackId,
	trackType,
	trackName,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
	trackType: Exclude<TrackType, "audio">;
	trackName?: string;
}): SceneTracks {
	const overlayInsertIndex = Math.min(insertIndex, tracks.overlay.length);
	const newTrack =
		trackType === "video"
			? buildEmptyTrack({ id: trackId, type: "video", name: trackName })
			: trackType === "text"
				? buildEmptyTrack({ id: trackId, type: "text", name: trackName })
				: trackType === "graphic"
					? buildEmptyTrack({ id: trackId, type: "graphic", name: trackName })
					: buildEmptyTrack({ id: trackId, type: "effect", name: trackName });
	return {
		...tracks,
		overlay: [
			...tracks.overlay.slice(0, overlayInsertIndex),
			newTrack,
			...tracks.overlay.slice(overlayInsertIndex),
		],
	};
}
