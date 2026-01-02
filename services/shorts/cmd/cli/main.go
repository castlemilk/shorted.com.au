package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/dgrijalva/jwt-go"
	// "github.com/google/uuid" // TODO: Use when needed
)

const (
	maxTokenLifetimeSecs = 3600
	googleTokenURL       = "https://www.googleapis.com/oauth2/v4/token"
)

func generateJWT(credentials []byte, audience string) (string, error) {
	var serviceAccountInfo struct {
		PrivateKey   string `json:"private_key"`
		ClientEmail  string `json:"client_email"`
		PrivateKeyID string `json:"private_key_id"`
	}

	err := json.Unmarshal(credentials, &serviceAccountInfo)
	log.Printf("serviceAccountInfo: %v", serviceAccountInfo)
	if err != nil {
		return "", err
	}

	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(serviceAccountInfo.PrivateKey))
	if err != nil {
		return "", fmt.Errorf("error parsing RSA private key: %v", err)
	}

	now := time.Now().Unix()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iat":             now,
		"exp":             now + maxTokenLifetimeSecs,
		"aud":             googleTokenURL,
		"target_audience": audience,
		"iss":             serviceAccountInfo.ClientEmail,
		"sub":             serviceAccountInfo.ClientEmail,
	})

	token.Header["kid"] = serviceAccountInfo.PrivateKeyID

	return token.SignedString(key)
}

func exchangeJWTForToken(signedJWT string) (string, error) {
	body := strings.NewReader(fmt.Sprintf(
		"grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=%s",
		signedJWT,
	))

	req, err := http.NewRequest("POST", googleTokenURL, body)
	if err != nil {
		return "", err
	}

	req.Header.Set("Authorization", "Bearer "+signedJWT)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			log.Printf("Error closing response body: %v", err)
		}
	}()

	var respData struct {
		IDToken string `json:"id_token"`
	}

	err = json.NewDecoder(resp.Body).Decode(&respData)
	if err != nil {
		return "", err
	}

	return respData.IDToken, nil
}

func main() {
	// uuid := uuid.New().String() // TODO: Use this when needed

	// Step 1: Load JSON credentials from environment variable
	credsEnv := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
	if credsEnv == "" {
		panic("environment variable GOOGLE_APPLICATION_CREDENTIALS_JSON is not set")
	}

	// serviceAccountFile :=
	audience := "https://bedrock-3ja2ysy6ma-ts.a.run.app" // Target audience

	signedJWT, err := generateJWT([]byte(credsEnv), audience)
	if err != nil {
		log.Fatalf("failed to generate JWT: %v", err)
	}

	idToken, err := exchangeJWTForToken(signedJWT)
	if err != nil {
		log.Fatalf("failed to exchange JWT for token: %v", err)
	}
	log.Printf("idToken: %v", idToken)

	if err != nil {
		panic(fmt.Sprintf("error creating token, %s", err))
	}

	// Step 3: Set up the gRPC client with the necessary headers
	interceptor := func(next connect.UnaryFunc) connect.UnaryFunc {
		return connect.UnaryFunc(func(
			ctx context.Context,
			req connect.AnyRequest,
		) (connect.AnyResponse, error) {
			if req.Spec().IsClient {
				// Send a token with client requests.
				log.Printf("setting token header for client request to %s", idToken)
				req.Header().Set("authorization", fmt.Sprintf("%s %s", "Bearer", idToken))
			} else if req.Header().Get("authorization") == fmt.Sprintf("%s %s", "Bearer", "") {
				// Check token in handlers.
				return nil, connect.NewError(
					connect.CodeUnauthenticated,
					errors.New("no token provided"),
				)
			}
			log.Printf("request headers: %v", req.Header())
			return next(ctx, req)
		})
	}

	// Create a connect-go gRPC client with the wrapped http.Client
	serviceClient := shortsv1alpha1connect.NewShortedStocksServiceClient(http.DefaultClient,
		// "http://localhost:50051",
		"https://bedrock-3ja2ysy6ma-ts.a.run.app",
		connect.WithGRPC(),
		connect.WithInterceptors(connect.UnaryInterceptorFunc(interceptor)))

	// // Your gRPC client call
	// registeredUser, err := serviceClient.RegisterUser(context.Background(), connect.NewRequest(&authenticationv1.RegisterRequest{
	// 	Username:        uuid,
	// 	Email:           "ben.ebsworth@gmail.com",
	// 	CountryCode:     "AU",
	// 	PhoneNumber:     "0406051122",
	// 	Password:        "Password123!",
	// 	PasswordConfirm: "Password123!",
	// }))

	stocks, err := serviceClient.GetTopShorts(context.Background(), connect.NewRequest(&shortsv1alpha1.GetTopShortsRequest{
		Period: "6m", Limit: 10}))
	if err != nil {
		log.Fatalf("failed to get top shorts: %v", err)
	}

	println("got stocksr %s", stocks.Msg.TimeSeries)
}
