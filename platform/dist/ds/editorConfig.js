import jwt from 'jsonwebtoken';
import { config } from '../config.js';
export function buildEditorConfig(params) {
    const { file, user } = params;
    const platformBaseUrl = config.PLATFORM_BASE_URL;
    // Sign a short-lived token for DS to fetch the file
    const serveToken = jwt.sign({ fileId: file.id }, config.DS_JWT_SECRET, { expiresIn: '1h' });
    const fileExtension = file.name.includes('.')
        ? file.name.split('.').pop()
        : '';
    const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
    const documentType = getDocumentType(fileExtension);
    const editorConfig = {
        documentType,
        document: {
            url: `${platformBaseUrl}/api/files/serve/${serveToken}`,
            title: file.name,
            fileType: fileExtension,
            key: documentKey,
            permissions: {
                edit: true,
                download: true,
            },
        },
        editorConfig: {
            mode: 'edit',
            callbackUrl: `${platformBaseUrl}/api/ds/callback?fileId=${file.id}`,
            user: {
                id: user.id,
                name: user.name,
            },
            customization: {
                forcesave: true,
            },
        },
    };
    // Sign the full config as a token for DS verification
    const token = jwt.sign(editorConfig, config.DS_JWT_SECRET);
    return { ...editorConfig, token };
}
function getDocumentType(ext) {
    if ('doc docx docm dot dotx dotm odt fodt ott rtf txt html htm mht xml pdf djvu fb2 epub xps oxps'.includes(ext))
        return 'word';
    if ('xls xlsx xlsm xlsb xlt xltx xltm ods fods ots csv'.includes(ext))
        return 'cell';
    if ('pps ppsx ppsm ppt pptx pptm pot potx potm odp fodp otp'.includes(ext))
        return 'slide';
    return 'word';
}
//# sourceMappingURL=editorConfig.js.map