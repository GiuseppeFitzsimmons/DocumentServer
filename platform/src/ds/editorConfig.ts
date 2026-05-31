import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { FileRecord } from '../storage/metadata.js';

interface EditorConfigParams {
  file: FileRecord;
  user: { id: string; name: string };
}

export function buildEditorConfig(params: EditorConfigParams): object {
  const { file, user } = params;
  const platformBaseUrl = config.PLATFORM_BASE_URL;

  // Sign a short-lived token for DS to fetch the file
  const serveToken = jwt.sign(
    { fileId: file.id },
    config.DS_JWT_SECRET,
    { expiresIn: '1h' }
  );

  const fileExtension = file.name.includes('.')
    ? file.name.split('.').pop()!
    : '';

  const documentKey = `${file.id}_${file.updatedAt.getTime()}`;

  const editorConfig = {
    document: {
      url: `${platformBaseUrl}/api/files/serve/${serveToken}`,
      title: file.name,
      fileType: fileExtension,
      key: documentKey,
    },
    editorConfig: {
      callbackUrl: `${platformBaseUrl}/api/ds/callback?fileId=${file.id}`,
      user: {
        id: user.id,
        name: user.name,
      },
    },
  };

  // Sign the full config as a token for DS verification
  const token = jwt.sign(editorConfig, config.DS_JWT_SECRET);

  return { ...editorConfig, token };
}
