// 用真机同款 zxing 解码器验证 server/lib/qr.js 生成的矩阵能否被识别。
// 用法：javac -cp <zxing-core.jar> test/QrDecode.java && java -cp "<zxing-core.jar>;test" QrDecode test/qr-matrix.txt
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class QrDecode {
    public static void main(String[] argv) throws Exception {
        List<String> lines = Files.readAllLines(Paths.get(argv[0]));
        String expect = lines.get(0);
        int n = lines.size() - 1;
        int scale = 4;
        int quiet = 4;
        int w = (n + quiet * 2) * scale;
        int[] px = new int[w * w];
        for (int i = 0; i < px.length; i++) px[i] = 0xFFFFFFFF;
        for (int r = 0; r < n; r++) {
            String line = lines.get(r + 1);
            for (int c = 0; c < n; c++) {
                if (line.charAt(c) != '1') continue;
                for (int dy = 0; dy < scale; dy++) {
                    for (int dx = 0; dx < scale; dx++) {
                        px[((r + quiet) * scale + dy) * w + (c + quiet) * scale + dx] = 0xFF000000;
                    }
                }
            }
        }
        Map<DecodeHintType, Object> hints = new HashMap<>();
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));
        Result res = new MultiFormatReader().decode(
                new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(w, w, px))), hints);
        System.out.println("modules : " + n + "x" + n);
        System.out.println("expect  : " + expect);
        System.out.println("decoded : " + res.getText());
        System.out.println("MATCH   : " + (res.getText().equals(expect) ? "yes" : "NO"));
    }
}
