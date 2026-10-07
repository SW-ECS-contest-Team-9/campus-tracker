package hoshi.campustracker.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import hoshi.campustracker.core.L
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface TokenStore {
    fun load(): String?
    fun save(token: String)
    fun clear()
}

/** Access token encrypted with an Android Keystore AES-GCM key; only ciphertext reaches SharedPreferences. */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs = context.getSharedPreferences("campus_collector_secure", Context.MODE_PRIVATE)
    private val alias = "campus_collector_token_key"

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    override fun load(): String? {
        val data = prefs.getString("token", null) ?: return null
        val iv = prefs.getString("iv", null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            L.w("TokenStore", "stored token unreadable; signing out", e)
            clear()
            null
        }
    }

    override fun save(token: String) {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            prefs.edit {
                putString("token", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            }
        } catch (e: Exception) {
            L.e("TokenStore", "token encryption failed", e)
        }
    }

    override fun clear() {
        prefs.edit { remove("token"); remove("iv") }
    }
}
