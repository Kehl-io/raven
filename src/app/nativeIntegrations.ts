import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

type NotificationMessage = {
  title: string;
  body: string;
};

export async function chooseArtifactDestinationFolder(): Promise<string | null> {
  return chooseFolder("Choose artifact destination folder");
}

export async function chooseAiChatImportFolder(): Promise<string | null> {
  return chooseFolder("Choose AI chat import folder");
}

export async function choosePdfDocumentImportFolder(): Promise<string | null> {
  return chooseFolder("Choose PDF document import folder");
}

async function chooseFolder(title: string): Promise<string | null> {
  try {
    const selectedPath = await open({
      canCreateDirectories: true,
      directory: true,
      multiple: false,
      title,
    });

    return typeof selectedPath === "string" ? selectedPath : null;
  } catch {
    return null;
  }
}

export async function notifyWorkflowRunCompleted(workflowName: string): Promise<void> {
  await sendRavenNotification({
    title: "Raven workflow completed",
    body: `${workflowName} finished successfully.`,
  });
}

export async function notifyWorkflowRunFailed(workflowName: string): Promise<void> {
  await sendRavenNotification({
    title: "Raven workflow failed",
    body: `${workflowName} needs attention.`,
  });
}

async function sendRavenNotification(message: NotificationMessage): Promise<void> {
  try {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === "granted";
    }

    if (permissionGranted) {
      await sendNotification(message);
    }
  } catch {
    // Browser-only tests and preview mode do not have native notification APIs.
  }
}
