package hoshi.campustracker.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.util.Locale

@Composable
fun SectionCard(background: Color? = null, content: @Composable ColumnScope.() -> Unit) {
    val modifier = Modifier.fillMaxWidth().let {
        if (background != null) it.background(background, RoundedCornerShape(12.dp)).padding(16.dp) else it
    }
    Column(modifier = modifier, content = content)
}

@Composable
fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(4.dp))
}

@Composable
fun Caption(text: String, color: Color = Color.Unspecified, singleLine: Boolean = false) {
    Text(
        text, style = MaterialTheme.typography.bodySmall, color = color,
        maxLines = if (singleLine) 1 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis,
    )
}

fun formatOne(value: Double?): String = value?.let { String.format(Locale.US, "%.1f", it) } ?: "—"

fun ageText(timestampMs: Long?, nowMs: Long): String =
    timestampMs?.let { String.format(Locale.US, "%.1fs ago", maxOf(0L, nowMs - it) / 1000.0) } ?: "—"
